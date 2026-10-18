import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, PORT, WRAPPER_ADMIN_PASSWORD, initializeGatewayToken } from './config/index.js';
import { assertPinnedRuntime } from './utils/version.js';
import { gatewayManager } from './services/gatewayManager.js';
import { pairingService } from './services/pairingService.js';
import { attachTerminalWebSocket, terminalWss, stopAllTerminalSessions } from './services/terminalService.js';
import { setupRoutes } from './routes/setup.js';
import { apiRoutes, isWrapperApiPath } from './routes/api.js';
import { requestLogger } from './middleware/logger.js';
import { requireAdminAuth, setAuthCookie, clearAuthCookie, isAdminAuthenticated,
  isAdminOriginAllowed, sanitizeReturnTo, passwordsEqual } from './middleware/auth.js';
import { recoverConfigEdit } from './services/configEditor.js';
import { recoverBeforeStartup, runBootUpgrade, prepareGateway } from './services/upgradeService.js';
import { isOperationActive, getBootFailure, setBootFailure, stopOperations } from './services/operations.js';
import { log } from './utils/log.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const escapeHtml = (value) => String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function unavailable(res) {
  res.setHeader('Retry-After','3');
  return res.status(503).json({ok:false,error: getBootFailure()
    ? 'Upgrade recovery requires attention. Open /admin to review status and retry deliberately.'
    : 'OpenClaw is starting or a maintenance operation is running. Please retry shortly.'});
}
export function createApp() {
  const app = express();
  const httpServer = createServer(app);
  app.disable('x-powered-by');
  const rawBody = (req, _res, buffer) => { req.rawBody = buffer; };
  const managementJson = express.json({ limit:'2mb', verify:rawBody });
  app.use('/api',(req,res,next)=>{
    if(isWrapperApiPath(req.path) || /^\/upgrade\/retry\/?$/i.test(req.path)) return managementJson(req,res,next);
    next();
  });
  app.use(['/setup','/login'],managementJson);
  app.use('/login',express.urlencoded({ extended:false,limit:'16kb' }));
  app.use(requestLogger);

  app.post('/api/upgrade/retry', requireAdminAuth, async (_req,res,next) => {
    try {
      const result = await runBootUpgrade({force:true});
      pairingService.startWatching();
      res.json({ok:true,...result});
    } catch(error) {next(error);}
  });
  app.use('/api',apiRoutes);
  app.use('/setup',setupRoutes);
  app.get('/api/pairing/stream',requireAdminAuth,async (req,res,next) => {
    if(isOperationActive() || getBootFailure()) return unavailable(res);
    try {
      const pending = await pairingService.getPending();
      if(isOperationActive() || getBootFailure()) return unavailable(res);
      res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({type:'pending',pending})}\n\n`);
      const changed = (pending) => res.write(`data: ${JSON.stringify({type:'pending',pending})}\n\n`);
      const update = (event) => res.write(`data: ${JSON.stringify({type:'update',...event})}\n\n`);
      pairingService.on('pendingChanged',changed);
      pairingService.on('pairingUpdate',update);
      req.on('close',()=>{pairingService.off('pendingChanged',changed);pairingService.off('pairingUpdate',update);});
    } catch(error) {next(error);}
  });

  app.get('/login',(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    if(!WRAPPER_ADMIN_PASSWORD) return res.status(503).type('text/plain').send('Set WRAPPER_ADMIN_PASSWORD in your Railway service variables, then redeploy to enable setup and administration.');
    const returnTo = escapeHtml(sanitizeReturnTo(req.query.returnTo));
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>OpenClaw Login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0f14;color:#c9d1d9;font-family:'IBM Plex Mono',monospace;
display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#14181f;border:1px solid #252d3d;border-radius:12px;padding:40px;width:360px}
h1{font-size:18px;color:#e85d26;margin-bottom:24px;text-align:center}
label{font-size:12px;color:#6b7688;display:block;margin-bottom:6px}
input{width:100%;background:#0d0f14;border:1px solid #252d3d;border-radius:7px;
color:#c9d1d9;font-family:inherit;font-size:13px;padding:9px 12px;outline:none;margin-bottom:16px}
input:focus{border-color:#e85d26}
button{width:100%;background:#e85d26;border:none;border-radius:8px;color:white;
font-family:inherit;font-size:14px;font-weight:600;padding:12px;cursor:pointer}
button:hover{background:#f0883e}
.err{color:#f85149;font-size:12px;margin-bottom:12px;text-align:center}</style>
</head><body><div class="card">
<h1>🦞 OpenClaw Admin</h1>
${req.query.err ? '<p class="err">Incorrect password</p>' : ''}
<form method="POST" action="/login">
<input type="hidden" name="returnTo" value="${returnTo}">
<label>Admin Password</label>
<input type="password" name="password" autofocus placeholder="Enter password">
<button type="submit">Sign In</button>
</form>
<p style="margin-top:16px;font-size:11px;color:#6b7688;text-align:center;line-height:1.6">This is the <span style="color:#f0883e">WRAPPER_ADMIN_PASSWORD</span> environment variable set in your Railway service variables.</p>
</div></body></html>`);
  });
  app.post('/login',(req,res)=>{
    if(!WRAPPER_ADMIN_PASSWORD) return res.status(503).json({ok:false,error:'Set WRAPPER_ADMIN_PASSWORD to enable administration.'});
    if(req.headers.origin && !isAdminOriginAllowed(req)) return res.status(403).json({ok:false,error:'Sign in from this deployment.'});
    const returnTo = sanitizeReturnTo(req.body?.returnTo);
    if(passwordsEqual(req.body?.password,WRAPPER_ADMIN_PASSWORD)){
      setAuthCookie(res,req.body.password,req);
      return res.redirect(returnTo);
    }
    res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}&err=1`);
  });
  app.get('/logout',(req,res)=>{clearAuthCookie(res,req);res.redirect('/login');});
  app.get('/admin',requireAdminAuth,(_req,res)=>res.sendFile(path.join(publicDir,'admin.html')));
  app.use('/ui',(req,res)=>res.redirect('/'+(req.url||'').replace(/^\//,'')));
  app.get('/',async (_req,res,next)=>{
    if(isOperationActive() || getBootFailure()) return unavailable(res);
    if(await config.isAlreadyConfigured()) return next();
    res.redirect('/setup');
  });
  app.use((req,res,next)=>{
    if(isOperationActive() || getBootFailure()) return unavailable(res);
    if(!gatewayManager.isRunning()) return unavailable(res);
    req.url = req.originalUrl;
    gatewayManager.getHttpProxy().web(req,res);
  });
  app.use((error,_req,res,_next)=>{
    if(res.headersSent) return res.end();
    const status = Number.isInteger(error.status) && error.status>=400 && error.status<=599 ? error.status : 500;
    const bodyError = error.type === 'entity.parse.failed' || status === 413;
    log.error('Request failed:',bodyError ? (error.type || 'request body limit') : error.message);
    const message = status===500 ? 'The operation failed. Review the server logs before retrying.'
      : bodyError ? (status===413 ? 'Request body is too large.' : 'Invalid request body.') : error.message;
    res.status(status).json({ok:false,error:message});
  });

  attachTerminalWebSocket(httpServer);
  httpServer.on('upgrade',(req,socket,head)=>{
    let pathname;
    try {pathname=new URL(req.url,'http://wrapper.invalid').pathname;}catch{socket.destroy();return;}
    if(isOperationActive() || getBootFailure()){
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;
    }
    if(pathname==='/ws/terminal'){
      if(!isAdminAuthenticated(req) || !isAdminOriginAllowed(req)){
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;
      }
      if(!gatewayManager.isRunning()){
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;
      }
      terminalWss.handleUpgrade(req,socket,head,(ws)=>terminalWss.emit('connection',ws,req));
      return;
    }
    gatewayManager.handleWsUpgrade(req,socket,head);
  });
  return {app,httpServer};
}
export async function startServer() {
  assertPinnedRuntime();
  try {
    await recoverBeforeStartup();
    await recoverConfigEdit();
  } catch(error) {
    setBootFailure('Recovery needs attention; original snapshots are retained. Review logs before retrying.');
    log.error('Startup recovery:',error.message);
  }
  try {initializeGatewayToken();}catch(error){setBootFailure('Stored configuration needs attention before startup.');log.error(error.message);}
  gatewayManager.setPreflight(prepareGateway);
  const {app,httpServer}=createApp();
  await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(PORT,'0.0.0.0',resolve);});
  log.info(`OpenClaw Railway listening on ${PORT}`);
  let boot = Promise.resolve();
  if(await config.isAlreadyConfigured() && !getBootFailure()){
    boot=runBootUpgrade().then(()=>pairingService.startWatching()).catch(error=>log.error('Boot upgrade:',error.message));
  }
  let stopping=false;
  async function shutdown(){
    if(stopping)return;
    stopping=true;
    const deadline=setTimeout(()=>process.exit(1),355000);deadline.unref();
    await stopOperations();
    pairingService.stopWatching();
    await stopAllTerminalSessions();
    await gatewayManager.shutdown();
    httpServer.closeAllConnections();
    await new Promise(resolve=>httpServer.close(resolve));
    clearTimeout(deadline);
  }
  return {app,httpServer,boot,shutdown};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  startServer().then(({shutdown})=>{
    for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>shutdown().then(()=>process.exit(0)).catch(error=>{log.error(error.message);process.exit(1);}));
  }).catch(error=>{console.error('Startup failed:',error.message);process.exit(1);});
}
