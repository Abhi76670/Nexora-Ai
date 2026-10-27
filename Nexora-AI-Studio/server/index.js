import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import AdmZip from 'adm-zip';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

dotenv.config({ path: path.resolve('../.env') });

const app = express();
const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve('workspaces');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_COMMAND_MS = 25_000;
const MAX_COMMAND_OUTPUT = 120_000;
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

await fs.mkdir(ROOT, { recursive: true });
app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 45, standardHeaders: true, legacyHeaders: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ZIP_BYTES, files: 1 } });

function send(res, event) { res.write(`data: ${JSON.stringify(event)}\n\n`); }
function validSession(id) { return typeof id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(id); }
function sessionDir(id) {
  if (!validSession(id)) throw new Error('Invalid sessionId');
  return path.join(ROOT, id);
}
function safePath(base, relative) {
  if (typeof relative !== 'string' || !relative.trim()) throw new Error('A file path is required');
  const normalized = relative.replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized.split('/').some(p => p === '..' || p === '.')) throw new Error('Unsafe file path');
  const full = path.resolve(base, normalized);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Unsafe file path');
  return full;
}
async function walk(dir, base = dir, output = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (output.length >= MAX_FILES) break;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, output);
    else {
      const st = await fs.stat(full).catch(() => null);
      if (st?.isFile()) output.push({ path: path.relative(base, full).split(path.sep).join('/'), size: st.size, sizeLabel: st.size < 1024 ? `${st.size} B` : `${(st.size/1024).toFixed(1)} KB` });
    }
  }
  return output;
}
async function readTextFile(base, relative) {
  const full = safePath(base, relative);
  const stat = await fs.stat(full);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('File is not a regular text file or exceeds 2 MB');
  return fs.readFile(full, 'utf8');
}
async function writeTextFile(base, relative, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('File content must be text under 2 MB');
  const full = safePath(base, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}
function extractZipSafely(buffer, base) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_FILES) throw new Error(`ZIP contains too many entries (max ${MAX_FILES})`);
  const validated = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const relative = entry.entryName.replaceAll('\\\\', '/');
    const dest = safePath(base, relative);
    if (relative.split('/').some(p => ['node_modules', '.git', '.env'].includes(p))) continue;
    const data = entry.getData();
    if (data.length > MAX_FILE_BYTES) continue;
    validated.push({ relative, dest, data });
  }
  for (const item of validated) {
    fsSyncMkdirWrite(path.dirname(item.dest), item.dest, item.data);
  }
  return validated.length;
}
import { mkdirSync, writeFileSync } from 'node:fs';
function fsSyncMkdirWrite(parent, dest, data) { mkdirSync(parent, { recursive: true }); writeFileSync(dest, data); }

const declarations = [
  { name:'list_files', description:'List project files. Use before editing or debugging an uploaded project.', parameters:{type:'OBJECT',properties:{},required:[]} },
  { name:'read_file', description:'Read a project text file to inspect code or find a bug.', parameters:{type:'OBJECT',properties:{path:{type:'STRING',description:'Relative path, e.g. src/App.jsx'}},required:['path']} },
  { name:'write_file', description:'Create or replace a project file with generated/fixed code.', parameters:{type:'OBJECT',properties:{path:{type:'STRING'},content:{type:'STRING'}},required:['path','content']} },
  { name:'search_files', description:'Search project text files for a literal string, function name, or error term.', parameters:{type:'OBJECT',properties:{query:{type:'STRING'}},required:['query']} },
  { name:'create_project_zip', description:'Create a downloadable ZIP from all current project files after generation or edits.', parameters:{type:'OBJECT',properties:{},required:[]} },
  { name:'inspect_project', description:'Inspect the project structure and summarize the likely project type from file names.', parameters:{type:'OBJECT',properties:{},required:[]} },
  { name:'run_command', description:'Run a limited, non-interactive project command for tests/builds or Python/Node scripts. Allowed commands: npm run build, npm test, node <relative .js file>, python/python3 <relative .py file>, ls, pwd, curl only to localhost/127.0.0.1. Never run destructive commands, shell operators, sudo, package install, or arbitrary shell.', parameters:{type:'OBJECT',properties:{command:{type:'STRING',description:'One allowed command, no shell operators'}},required:['command']} }
];

async function runTool(name, args, base, emit) {
  if (name === 'list_files' || name === 'inspect_project') {
    emit({type:'status',label:name==='inspect_project'?'Analyzing project structure':'Searching files',detail:'Reading actual workspace file list',state:'working'});
    const files = await walk(base);
    return JSON.stringify({files, projectType: files.some(f=>f.path==='package.json')?'JavaScript/Node project':files.some(f=>f.path.endsWith('.py'))?'Python project':files.some(f=>f.path.endsWith('.html'))?'HTML project':'Unknown or empty project'});
  }
  if (name === 'read_file') {
    emit({type:'status',label:`Viewing ${path.basename(args.path)}`,detail:args.path,state:'working'});
    return await readTextFile(base, args.path);
  }
  if (name === 'write_file') {
    await writeTextFile(base, args.path, args.content);
    emit({type:'status',label:`Updated ${path.basename(args.path)}`,detail:args.path,state:'done'});
    emit({type:'artifact',label:'Project file saved',path:args.path});
    return JSON.stringify({ok:true,path:args.path,bytes:Buffer.byteLength(args.content)});
  }
  if (name === 'search_files') {
    emit({type:'status',label:'Searching files',detail:`Searching for "${String(args.query).slice(0,80)}"`,state:'working'});
    const files = await walk(base);
    const matches = [];
    for (const f of files) {
      if (matches.length >= 30) break;
      if (f.size > MAX_FILE_BYTES) continue;
      const content = await fs.readFile(safePath(base,f.path),'utf8').catch(()=> '');
      const lines = content.split('\n');
      lines.forEach((line,i)=>{ if(line.toLowerCase().includes(String(args.query).toLowerCase()) && matches.length<30) matches.push({path:f.path,line:i+1,text:line.slice(0,240)}); });
    }
    return JSON.stringify(matches);
  }
  if (name === 'run_command') {
    const command = String(args.command || '').trim();
    const parsed = parseAllowedCommand(command, base);
    emit({type:'status',label:parsed.label,detail:command,state:'working'});
    const result = await executeCommand(parsed, base);
    emit({type:'status',label:result.code === 0 ? 'Command completed' : 'Command reported an error',detail:`exit code ${result.code}`,state:result.code === 0 ? 'done' : 'error'});
    emit({type:'terminal',command,output:result.output,exitCode:result.code});
    return JSON.stringify(result);
  }
  if (name === 'create_project_zip') {
    emit({type:'status',label:'Packaging project ZIP',detail:'Collecting workspace files',state:'working'});
    const zip = new AdmZip();
    const files = (await walk(base)).filter(f => f.path !== '.nexora/project.zip');
    for (const f of files) zip.addFile(f.path, await fs.readFile(safePath(base,f.path)));
    await fs.mkdir(path.join(base,'.nexora'),{recursive:true});
    await fs.writeFile(path.join(base,'.nexora','project.zip'),zip.toBuffer());
    emit({type:'artifact',label:'Project ZIP created',path:'Download ZIP'});
    return JSON.stringify({ok:true,fileCount:files.length,downloadUrl:'/api/download-zip'});
  }
  return JSON.stringify({error:'Unknown tool'});
}

function parseAllowedCommand(command, base) {
  if (!command || command.length > 500 || /[;&|`$<>\n\r]/.test(command)) throw new Error('Use one simple command without shell operators. Type help for allowed commands.');
  const parts = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(x => x.replace(/^['"]|['"]$/g, '')) || [];
  const [cmd, ...args] = parts;
  if (cmd === 'pwd' && !args.length) return {cmd:'pwd',args:[],label:'Checking workspace'};
  if ((cmd === 'ls' || cmd === 'find') && args.length <= 2) return {cmd:'workspace-list',args,label:'Listing project files'};
  if (cmd === 'cat' && args.length === 1) return {cmd:'cat',args,label:`Reading ${path.basename(args[0])}`};
  if (cmd === 'wc' && args.length === 1) return {cmd:'wc',args,label:`Counting ${path.basename(args[0])}`};
  if (cmd === 'node' && args.length === 1 && args[0].endsWith('.js')) return {cmd,args,label:`Running ${path.basename(args[0])}`};
  if ((cmd === 'python' || cmd === 'python3') && args.length === 1 && args[0].endsWith('.py')) return {cmd,args,label:`Running ${path.basename(args[0])}`};
  if (cmd === 'npm' && args.length === 1 && args[0] === 'install') return {cmd,args,label:'Installing project dependencies'};
  if (cmd === 'npm' && args.length === 2 && args[0] === 'run' && args[1] === 'build') return {cmd,args,label:'Building project'};
  if (cmd === 'python3' && args.length === 3 && args[0] === '-m' && args[1] === 'pip' && args[2] === 'install') return {cmd,args,label:'Installing Python dependencies'};
  if (cmd === 'npm' && args.length === 1 && args[0] === 'test') return {cmd,args,label:'Running tests'};
  if (cmd === 'curl' && args.length >= 1 && args.length <= 3 && args.every(a => !a.startsWith('-')) && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/.test(args[0])) return {cmd,args,label:'Testing local endpoint'};
  throw new Error('Command not allowed. Try help, pwd, ls, cat <file>, wc <file>, node <file.js>, python3 <file.py>, npm install, npm run build, npm test, or curl http://localhost:<port>.');
}
async function executeCommand(parsed, base) {
  if (parsed.cmd === 'pwd') return {code:0,output:`/workspace/${path.basename(base)}`};
  if (parsed.cmd === 'workspace-list') return {code:0,output:(await walk(base)).map(f=>f.path).join('\n') || '(no files yet)'};
  if (parsed.cmd === 'cat') return {code:0,output:await readTextFile(base,parsed.args[0])};
  if (parsed.cmd === 'wc') { const c=await readTextFile(base,parsed.args[0]); return {code:0,output:`${c.split('\n').length} lines  ${Buffer.byteLength(c)} bytes`}; }
  const relative = parsed.args[0];
  if (['node','python','python3'].includes(parsed.cmd)) safePath(base, relative);
  return await new Promise(resolve => {
    const child = spawn(parsed.cmd, parsed.args, {cwd:base, shell:false, env:{...process.env, GEMINI_API_KEY:'', GOOGLE_API_KEY:''}});
    let output='';
    const collect = chunk => { output += chunk.toString(); if (output.length > MAX_COMMAND_OUTPUT) { output = output.slice(0,MAX_COMMAND_OUTPUT) + '\n[output truncated]'; child.kill('SIGTERM'); } };
    child.stdout.on('data',collect); child.stderr.on('data',collect);
    const timer=setTimeout(()=>{ child.kill('SIGTERM'); },MAX_COMMAND_MS);
    child.on('error',err=>{clearTimeout(timer); resolve({code:127,output:`Could not run command: ${err.message}. Install the required runtime in Termux.`});});
    child.on('close',code=>{clearTimeout(timer); resolve({code:code ?? 1,output:output.trim() || '(no output)'});});
  });
}

app.get('/api/health', (_req,res)=>res.json({ok:true,configured:Boolean(ai),model:MODEL}));
app.get('/api/files', async (req,res)=>{
  try { const base=sessionDir(req.query.sessionId); res.json({files:await walk(base)}); }
  catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/file', async (req,res)=>{
  try { const base=sessionDir(req.query.sessionId); res.json({path:req.query.path,content:await readTextFile(base,req.query.path)}); }
  catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/file', async (req,res)=>{
  try { const base=sessionDir(req.body.sessionId); await writeTextFile(base,req.body.path,req.body.content); res.json({ok:true}); }
  catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/upload-zip', upload.single('file'), async (req,res)=>{
  try {
    if(!req.file) return res.status(400).json({error:'Upload a ZIP file'});
    const base=sessionDir(req.query.sessionId); await fs.mkdir(base,{recursive:true});
    const count=extractZipSafely(req.file.buffer,base);
    res.json({ok:true,count});
  } catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/download-zip', async (req,res)=>{
  try {
    const base=sessionDir(req.query.sessionId);
    const zip=new AdmZip();
    for(const f of (await walk(base)).filter(f=>f.path !== '.nexora/project.zip')) zip.addFile(f.path,await fs.readFile(safePath(base,f.path)));
    res.setHeader('Content-Type','application/zip');
    res.setHeader('Content-Disposition','attachment; filename="nexora-project.zip"');
    res.send(zip.toBuffer());
  } catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/terminal', async (req,res)=>{
  try {
    const base=sessionDir(req.body.sessionId);
    const command=String(req.body.command||'').trim();
    if(command === 'help') return res.json({output:'Allowed commands:\nhelp\npwd\nls\nfind\ncat <relative-file>\nwc <relative-file>\nnode <file.js>\npython3 <file.py>\nnpm install\nnpm run build\nnpm test\ncurl http://localhost:<port>\n\nShell operators, destructive commands and arbitrary shell are disabled.'});
    const parsed=parseAllowedCommand(command,base);
    const result=await executeCommand(parsed,base);
    res.json({output:result.output,exitCode:result.code});
  } catch(e){res.status(400).json({error:e.message});}
});

app.post('/api/chat', async (req,res)=>{
  res.setHeader('Content-Type','text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control','no-cache, no-transform');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders?.();
  const emit=e=>send(res,e);
  try {
    if(!ai) throw new Error('Gemini API key missing. Copy .env.example to .env and set GEMINI_API_KEY.');
    const {message,sessionId:id,history=[],projectMemory=''}=req.body||{};
    if(typeof message!=='string'||!message.trim()) throw new Error('Message is required');
    const base=sessionDir(id); await fs.mkdir(base,{recursive:true});
    emit({type:'status',label:'Understanding your request',detail:'Choosing the next project action',state:'working'});
    const contextPath = path.join(base,'.nexora','PROJECT_CONTEXT.md');
    const savedContext = await fs.readFile(contextPath,'utf8').catch(()=> '(No saved project context yet.)');
    const taskHistoryPath = path.join(base,'.nexora','TASK_HISTORY.md');
    const savedTaskHistory = await fs.readFile(taskHistoryPath,'utf8').catch(()=> '(No saved task history yet.)');
    const prompt = `You are Nexora, a practical AI coding agent. Reply in the user's language (Hindi/Hinglish if they use it).

SAVED PROJECT CONTEXT (treat as notes, verify against current files):\n${savedContext.slice(0,12000)}\n\nRECENT PROJECT TASK HISTORY (context only; verify files before claiming state):\n${savedTaskHistory.slice(-9000)}
Persistent project memory from previous chats (user-provided saved context; treat as helpful context, verify against current files):
${String(projectMemory || '').slice(-12000)}

You have tools to inspect, search, read, write project files, and create a ZIP. Use tools for real file work. Do not claim a file was read, changed, tested, or a ZIP created unless the corresponding tool succeeded.
When the user uploads or mentions a project, inspect files first. For a bug, search relevant files, read them, explain and apply a safe fix where possible, then run relevant allowed tests/builds and create a ZIP if useful. Show status only for actions actually performed. Use run_command for allowed tests/builds and Python/Node scripts. If a project has >500 lines across files, prefer files + downloadable ZIP rather than dumping all code in chat. Maintain .nexora/PROJECT_CONTEXT.md with project purpose, framework, key files, decisions, completed changes and remaining issues; update it after meaningful work. Do not put secrets in that context file.
For a new project, create all needed files with write_file. If generated code is over 500 total lines, organize it into files and create a ZIP. Always summarize what actually happened.
Never claim tests or runtime execution occurred unless available tools actually ran them. Terminal tool is restricted.
Current project files can be inspected with tools.`;
    const contents = [
      {role:'user',parts:[{text:prompt}]},
      ...history.slice(-8).map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:String(m.text||'').slice(0,5000)}]})),
      {role:'user',parts:[{text:message}]}
    ];
    let lastText='';
    let zipReady=false;
    for(let turn=0; turn<8; turn++){
      const response=await ai.models.generateContent({
        model:MODEL,
        contents,
        config:{tools:[{functionDeclarations:declarations}],temperature:0.35}
      });
      const candidate=response.candidates?.[0];
      const modelContent=candidate?.content;
      if(!modelContent) throw new Error('Gemini returned no content. Check model availability and API quota.');
      contents.push(modelContent);
      const calls=modelContent.parts?.filter(p=>p.functionCall?.name)||[];
      if(!calls.length){
        lastText=modelContent.parts?.map(p=>p.text||'').join('\n').trim();
        break;
      }
      for(const part of calls){
        const fc=part.functionCall;
        emit({type:'status',label:({list_files:'Searching files',read_file:`Viewing ${path.basename(fc.args?.path||'file')}`,write_file:`Writing ${path.basename(fc.args?.path||'file')}`,search_files:'Finding errors',create_project_zip:'Creating project ZIP',inspect_project:'Analyzing project',run_command:'Running project command'}[fc.name]||'Working on project'),detail:fc.args?.path||'',state:'working'});
        let result;
        try { result=await runTool(fc.name,fc.args||{},base,emit); }
        catch(e){ result=JSON.stringify({error:e.message}); emit({type:'status',label:'Tool action failed',detail:e.message,state:'error'}); }
        if(fc.name==='create_project_zip' && !String(result).includes('"error"')) zipReady=true;
        contents.push({role:'user',parts:[{functionResponse:{name:fc.name,response:{result}}}]});
      }
    }
    if(!lastText) lastText='I completed the available project actions. Check the Files panel for generated files.';
    // Render oversized code responses as a file artifact rather than a huge chat dump.
    const lineCount=lastText.split('\n').length;
    if(lineCount>500){
      const filename='generated-output.md';
      await writeTextFile(base,filename,lastText);
      emit({type:'artifact',label:'Long output saved as a file',path:filename});
      lastText=`This response was over 500 lines, so I saved it to **${filename}** in your project workspace. Open Files or download the project ZIP to access it.\n\n${lastText.slice(0,700)}\n\n…Remaining content is saved in the file.`;
    }
    // Send small text chunks so the UI renders the answer progressively. Tool/activity events above are real backend actions.
    for (let i=0; i<lastText.length; i+=48) { emit({type:'text',text:lastText.slice(i,i+48)}); await new Promise(r=>setTimeout(r,12)); }
    await fs.mkdir(path.join(base,'.nexora'),{recursive:true});
    const safeUserTask = String(message).replace(/AIza[0-9A-Za-z_-]{20,}/g,'[REDACTED_API_KEY]').slice(0,700);
    const safeOutcome = String(lastText).replace(/AIza[0-9A-Za-z_-]{20,}/g,'[REDACTED_API_KEY]').slice(0,900);
    const historyEntry = `\n\n## ${new Date().toISOString()}\n- Request: ${safeUserTask.replace(/\n/g,' ')}\n- Outcome: ${safeOutcome.replace(/\n/g,' ')}\n`;
    const priorHistory = await fs.readFile(taskHistoryPath,'utf8').catch(()=> '# Nexora task history\n');
    await fs.writeFile(taskHistoryPath,(priorHistory + historyEntry).slice(-24000),'utf8');
    const files=await walk(base);
    let totalLines=0;
    for (const f of files) { if (f.path === '.nexora/project.zip' || f.size > MAX_FILE_BYTES) continue; const t=await fs.readFile(safePath(base,f.path),'utf8').catch(()=> ''); totalLines += t.split('\n').length; }
    if (totalLines > 500 && !zipReady) { const zip = new AdmZip(); for (const f of files.filter(f=>f.path !== '.nexora/project.zip')) zip.addFile(f.path,await fs.readFile(safePath(base,f.path))); await fs.mkdir(path.join(base,'.nexora'),{recursive:true}); await fs.writeFile(path.join(base,'.nexora','project.zip'),zip.toBuffer()); zipReady=true; emit({type:'artifact',label:'Large project ZIP created',path:`${totalLines} lines across project files`}); }
    const index=files.find(f=>f.path.toLowerCase()==='index.html');
    let previewHtml='';
    if(index){previewHtml=await readTextFile(base,index.path).catch(()=> '');}
    emit({type:'done',zipReady,previewHtml});
    res.end();
  } catch(e){
    emit({type:'error',message:e.message||'Unknown server error'});
    res.end();
  }
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Nexora API listening on http://localhost:${PORT} (model ${MODEL})`));