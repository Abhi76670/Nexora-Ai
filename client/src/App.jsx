import React, { useEffect, useRef, useState } from 'react';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, serverTimestamp, query, orderBy, limit } from 'firebase/firestore';
import { db } from './firebase.js';
import { Menu, Plus, ArrowUp, Paperclip, Code2, Terminal, Eye, Folder, Download, Copy, Check, X, PanelLeftClose, LoaderCircle, FileCode2, Sparkles, ChevronDown, Bug, Archive, RefreshCw } from 'lucide-react';

const sessionId = (() => {
  const key = `nexora-session-${authUser?.uid || 'guest'}`;
  let id = localStorage.getItem(key);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(key, id); }
  return id;
})();

function CodeBlock({ code, language = 'code' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return <div className="codeblock">
    <div className="codehead"><span>{language}</span><button onClick={copy} className="copybtn">{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? 'Copied' : 'Copy code'}</button></div>
    <pre><code>{code}</code></pre>
  </div>;
}

function renderMarkdown(text) {
  // Small dependency-free renderer: safely escapes HTML, then formats fenced code and simple Markdown.
  const esc = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const parts = text.split(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g);
  const result = [];
  for (let i=0; i<parts.length; i++) {
    if (i % 3 === 1) { result.push({type:'code', lang:parts[i] || 'code', code:parts[i+1] || ''}); i++; }
    else if (parts[i]) result.push({type:'text', text:parts[i]});
  }
  return result;
}
function Markdown({ text }) {
  const pieces = renderMarkdown(text);
  return <div className="markdown">{pieces.map((p,i) => p.type === 'code'
    ? <CodeBlock key={i} language={p.lang} code={p.code.replace(/\n$/, '')}/>
    : <div key={i} className="prose" dangerouslySetInnerHTML={{__html: p.text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>')
      .replace(/^# (.+)$/gm,'<h1>$1</h1>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/`([^`]+)`/g,'<code>$1</code>').replace(/^\s*[-*] (.+)$/gm,'<li>$1</li>')
      .replace(/\n/g,'<br/>')}}/> )}</div>;
}

export default function App({ authUser }) {
  const [messages, setMessages] = useState(() => { try { return JSON.parse(localStorage.getItem(`nexora-messages-${sessionId}`) || '[]'); } catch { return []; } });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [activities, setActivities] = useState([]);
  const [files, setFiles] = useState([]);
  const [panel, setPanel] = useState('chat');
  const [selectedFile, setSelectedFile] = useState('');
  const [fileText, setFileText] = useState('');
  const [terminalCmd, setTerminalCmd] = useState('help');
  const [terminalOut, setTerminalOut] = useState('Nexora terminal ready. Type "help" for supported commands.');
  const [previewHtml, setPreviewHtml] = useState('');
  const [showSidebar, setShowSidebar] = useState(true);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);
  const uploadRef = useRef(null);

  async function refreshFiles() {
    try {
      const r = await fetch(`/api/files?sessionId=${sessionId}`);
      const d = await r.json(); if (r.ok) setFiles(d.files || []);
    } catch {}
  }
  useEffect(() => { refreshFiles(); }, []);
  useEffect(() => { try { localStorage.setItem(`nexora-messages-${sessionId}`, JSON.stringify(messages.slice(-60))); } catch {} }, [messages]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }); }, [messages, activities]);

  async function openFile(path) {
    setSelectedFile(path); setPanel('files');
    try {
      const r = await fetch(`/api/file?sessionId=${sessionId}&path=${encodeURIComponent(path)}`);
      const d = await r.json(); setFileText(d.content || d.error || '');
    } catch { setFileText('Could not load file.'); }
  }
  async function saveFile() {
    const r = await fetch('/api/file', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sessionId, path:selectedFile, content:fileText})});
    const d = await r.json();
    if (!r.ok) setError(d.error || 'Save failed'); else { setError(''); refreshFiles(); }
  }

  async function sendMessage(text = input) {
    const message = text.trim();
    if (!message || busy) return;
    setInput(''); setBusy(true); setError('');
    setActivities([]);
    const userMsg = { role:'user', text:message };
    const aiMsg = { role:'assistant', text:'' };
    const startedMessages = [...messages, userMsg, aiMsg];
    setMessages(startedMessages);
    await persistChat(startedMessages, message.slice(0,64));
    let assistantText = '';
    try {
      const response = await fetch('/api/chat', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ message, sessionId, projectMemory, history: messages.slice(-10).map(m => ({role:m.role, text:m.text})) })
      });
      if (!response.ok || !response.body) {
        const d = await response.json().catch(()=>({}));
        throw new Error(d.error || `Request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream:true});
        const events = buffer.split('\n\n'); buffer = events.pop() || '';
        for (const raw of events) {
          const line = raw.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let event; try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (event.type === 'status') setActivities(prev => [...prev, {label:event.label, detail:event.detail || '', state:event.state || 'working'}]);
          if (event.type === 'text') {
            assistantText += event.text;
            setMessages(prev => { const n=[...prev]; n[n.length-1]={role:'assistant',text:assistantText}; persistChat(n); saveProjectMemory(n); return n; });
          }
          if (event.type === 'terminal') { setTerminalOut(`$ ${event.command}\n${event.output}\n\n[exit ${event.exitCode}]`); }
          if (event.type === 'artifact') {
            setActivities(prev => [...prev, {label:event.label || 'Artifact ready', detail:event.path || '', state:'done'}]);
            refreshFiles();
          }
          if (event.type === 'error') throw new Error(event.message || 'AI request failed');
          if (event.type === 'done') {
            if (event.previewHtml) setPreviewHtml(event.previewHtml);
            if (event.zipReady) setActivities(prev => [...prev, {label:'Project ZIP ready', detail:'Use Download ZIP in the toolbar.', state:'done'}]);
          }
        }
      }
      await refreshFiles();
    } catch (e) {
      setError(e.message);
      setMessages(prev => { const n=[...prev]; if (n.length && n[n.length-1].role==='assistant') n[n.length-1].text += `\n\n**Error:** ${e.message}`; return n; });
    } finally { setBusy(false); }
  }

  async function uploadZip(file) {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch(`/api/upload-zip?sessionId=${sessionId}`, {method:'POST', body:fd});
    const d = await r.json();
    if (!r.ok) setError(d.error || 'Upload failed');
    else { setError(''); await refreshFiles(); setPanel('files'); setActivities([{label:'ZIP extracted',detail:`${d.count} files imported`,state:'done'}]); }
  }
  async function downloadZip() {
    window.location.href = `/api/download-zip?sessionId=${sessionId}`;
  }
  async function runTerminal() {
    const r = await fetch('/api/terminal', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,command:terminalCmd})});
    const d = await r.json(); setTerminalOut(d.output || d.error || 'No output'); setPanel('terminal');
  }
  async function makePreview() {
    const candidate = files.find(f => /(^|\/)index\.html$/i.test(f.path));
    if (!candidate) { setError('No index.html found. Ask Nexora to create an HTML project first.'); return; }
    const r = await fetch(`/api/file?sessionId=${sessionId}&path=${encodeURIComponent(candidate.path)}`);
    const d = await r.json(); setPreviewHtml(d.content || ''); setPanel('preview');
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="iconbtn" onClick={()=>setShowSidebar(!showSidebar)} aria-label="Toggle sidebar"><Menu/></button>
      <div className="brand"><span className="brandmark"><Sparkles size={19}/></span><b>Nexora</b><span className="brand-sub">AI Studio</span><ChevronDown size={16}/></div>
      <div className="top-actions">
        <button className="iconbtn" title="Upload ZIP" onClick={()=>uploadRef.current?.click()}><Paperclip/></button>
        <input ref={uploadRef} hidden type="file" accept=".zip,application/zip" onChange={e=>uploadZip(e.target.files?.[0])}/>
        <button className="iconbtn" title="Download project ZIP" onClick={downloadZip}><Download/></button>
      </div>
    </header>
    <div className="workspace">
      {showSidebar && <aside className="sidebar">
        <button className="newchat" onClick={startNewChat}><Plus size={17}/> New chat</button>
        <div className="side-label">WORKSPACE</div>
        <button className={panel==='chat'?'side-item active':'side-item'} onClick={()=>setPanel('chat')}><Sparkles size={16}/> Chat</button>
        <button className={panel==='files'?'side-item active':'side-item'} onClick={()=>{setPanel('files');refreshFiles()}}><Folder size={16}/> Files <span className="count">{files.length}</span></button>
        <button className={panel==='terminal'?'side-item active':'side-item'} onClick={()=>setPanel('terminal')}><Terminal size={16}/> Terminal</button>
        <button className={panel==='preview'?'side-item active':'side-item'} onClick={makePreview}><Eye size={16}/> Preview</button>
        <div className="side-label chat-history-label">RECENT CHATS</div>
        <div className="chat-history">{chatList.map(chat=><button key={chat.id} className={activeChatId===chat.id?'history-item active':'history-item'} onClick={()=>openChat(chat)} title={chat.title}><span>{chat.title||'New chat'}</span></button>)}</div>
        <div className="side-bottom"><div className="status-dot"/> Gemini connected through server<br/><span>Local development workspace</span></div>
      </aside>}
      <main className="main">
        <div className="toolbar">
          <div className="tabs">
            {['chat','files','terminal','preview'].map(p=><button key={p} className={panel===p?'tab active':'tab'} onClick={()=>p==='preview'?makePreview():setPanel(p)}>{p==='chat'?'Chat':p==='files'?'Files':p==='terminal'?'Terminal':'Preview'}</button>)}
          </div>
          <button className="iconbtn small" title="Refresh files" onClick={refreshFiles}><RefreshCw size={15}/></button>
        </div>

        {panel==='chat' && <section className="chat-panel">
          {!memoryLoaded && <div className="memory-loading"><LoaderCircle size={15} className="spin"/> Loading your saved chats and project memory…</div>}
          {messages.length===0 && <div className="hero">
            <div className="hero-icon"><Sparkles size={30}/></div>
            <div className="eyebrow">YOUR AI BUILD PARTNER</div>
            <h1>What are we<br/><span>building today?</span></h1>
            <p>Ask in Hindi or English. Build projects, inspect ZIPs, debug code and preview your work.</p>
            <div className="prompt-grid">
              {[
                ['<Code2/>','Build a React landing page'],
                ['<Archive/>','Inspect my uploaded ZIP and find bugs'],
                ['<Bug/>','Explain and fix this error in Hindi'],
                ['<Terminal/>','Create a simple HTML project']
              ].map(([icon,label])=><button key={label} className="prompt-card" onClick={()=>sendMessage(label)}><Sparkles size={15}/>{label}<span>↗</span></button>)}
            </div>
          </div>}
          <div className="messages">
            {messages.map((m,i)=><div className={`message ${m.role}`} key={i}>
              <div className="message-avatar">{m.role==='user'?'Y':<Sparkles size={16}/>}</div>
              <div className="message-body">
                <div className="message-name">{m.role==='user'?'You':'Nexora'}</div>
                {m.role==='assistant' ? <Markdown text={m.text}/> : <div className="user-bubble">{m.text}</div>}
              </div>
            </div>)}
            {activities.length>0 && <div className="live-activity"><div className="activity-title">{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>} {busy ? 'Working on your request' : 'Recent activity'}</div>
              {activities.slice(-5).map((a,i)=><div className="activity-row" key={i}><span className={a.state==='done'?'activity-check':'activity-dot'}>{a.state==='done'?'✓':'·'}</span><div><b>{a.label}</b>{a.detail && <small>{a.detail}</small>}</div></div>)}
            </div>}
            <div ref={bottomRef}/>
          </div>
          {error && <div className="error-banner"><Bug size={16}/><span>{error}</span><button onClick={()=>setError('')}><X size={15}/></button></div>}
          <div className="composer-wrap">
            <form className="composer" onSubmit={e=>{e.preventDefault();sendMessage()}}>
              <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}}} placeholder="Describe what you want to build or fix..." rows={1}/>
              <button type="button" className="attach" title="Upload ZIP" onClick={()=>uploadRef.current?.click()}><Plus size={22}/></button>
              <button type="submit" className="send" disabled={busy||!input.trim()}>{busy?<LoaderCircle className="spin" size={19}/>:<ArrowUp size={20}/>}</button>
            </form>
            <div className="composer-note">Project memory saved · {authUser?.displayName || authUser?.email} · Review code and run tests before deployment.</div>
          </div>
        </section>}

        {panel==='files' && <section className="tool-panel">
          <div className="panel-heading"><div><h2><Folder size={20}/> Project files</h2><p>Files created or extracted for this session.</p></div><button className="primary-btn" onClick={downloadZip}><Download size={16}/> Download ZIP</button></div>
          <div className="file-layout"><div className="file-list">{files.length===0?<p className="muted">No files yet. Ask Nexora to create a project or upload a ZIP.</p>:files.map(f=><button key={f.path} className={selectedFile===f.path?'file-row selected':'file-row'} onClick={()=>openFile(f.path)}><FileCode2 size={16}/><span>{f.path}</span><small>{f.sizeLabel}</small></button>)}</div>
          <div className="editor"><div className="editor-head"><span>{selectedFile||'Choose a file'}</span>{selectedFile&&<button className="copybtn" onClick={saveFile}>Save file</button>}</div><textarea value={fileText} onChange={e=>setFileText(e.target.value)} spellCheck="false" placeholder="Select a file to view or edit its contents."/></div></div>
        </section>}

        {panel==='terminal' && <section className="tool-panel terminal-panel">
          <div className="panel-heading"><div><h2><Terminal size={20}/> Terminal</h2><p>Allowlisted project commands, test runs, builds and local endpoint checks.</p></div></div>
          <div className="terminal-window"><div className="terminal-top"><span/><span/><span/> nexora-terminal</div><pre>{terminalOut}</pre><form onSubmit={e=>{e.preventDefault();runTerminal()}} className="terminal-input"><span>$</span><input value={terminalCmd} onChange={e=>setTerminalCmd(e.target.value)} placeholder="help"/><button>Run</button></form></div>
          <p className="muted">Allowed: help, pwd, ls, cat, wc, node file.js, python3 file.py, npm run build, npm test, and curl to localhost. Arbitrary shell and package installation are disabled for safety.</p>
        </section>}

        {panel==='preview' && <section className="tool-panel preview-panel">
          <div className="panel-heading"><div><h2><Eye size={20}/> Live preview</h2><p>Sandboxed HTML preview.</p></div><button className="secondary-btn" onClick={makePreview}><RefreshCw size={15}/> Refresh</button></div>
          {previewHtml ? <iframe title="Project preview" sandbox="allow-forms allow-scripts" srcDoc={previewHtml} /> : <div className="empty-preview"><Eye size={32}/><h3>No preview yet</h3><p>Generate an HTML project or choose a project with an index.html file.</p><button className="primary-btn" onClick={()=>{setPanel('chat');setInput('Create a complete responsive HTML/CSS/JS page with a live preview.')}}>Create a project</button></div>}
        </section>}
      </main>
    </div>
  </div>;
}