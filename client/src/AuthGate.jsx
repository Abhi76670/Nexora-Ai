import React, { useEffect, useState } from 'react';
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, updateProfile, signOut } from 'firebase/auth';
import { auth } from './firebase.js';
import { Sparkles, Mail, LockKeyhole, UserRound, LoaderCircle, LogOut } from 'lucide-react';

export default function AuthGate({ children }) {
  const [user, setUser] = useState(undefined);
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'register') {
        if (name.trim().length < 2) throw new Error('Please enter your name (at least 2 characters).');
        if (password.length < 6) throw new Error('Password must contain at least 6 characters.');
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(credential.user, { displayName: name.trim() });
        setUser({ ...credential.user, displayName: name.trim() });
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (e) {
      const messages = {
        'auth/email-already-in-use': 'This email already has an account. Please log in.',
        'auth/invalid-email': 'Enter a valid email address.',
        'auth/invalid-credential': 'Email or password is incorrect.',
        'auth/weak-password': 'Password must contain at least 6 characters.',
        'auth/operation-not-allowed': 'Enable Email/Password sign-in in Firebase Console → Authentication → Sign-in method.',
        'auth/network-request-failed': 'Network error. Check your internet connection.'
      };
      setError(messages[e.code] || e.message || 'Authentication failed.');
    } finally { setBusy(false); }
  }

  if (user === undefined) return <div className="auth-loading"><LoaderCircle className="spin" size={24}/><span>Loading Nexora…</span></div>;
  if (user) return <>{React.cloneElement(children, { authUser: user })}<button className="account-chip" title="Sign out" onClick={() => signOut(auth)}><span>{(user.displayName || user.email || 'U').slice(0,1).toUpperCase()}</span><b>{user.displayName || user.email}</b><LogOut size={15}/></button></>;

  return <div className="auth-screen">
    <div className="auth-card">
      <div className="auth-logo"><Sparkles size={26}/></div>
      <div className="auth-eyebrow">YOUR AI BUILD PARTNER</div>
      <h1>{mode === 'register' ? 'Create your account' : 'Welcome back'}</h1>
      <p className="auth-sub">{mode === 'register' ? 'Create an account to keep your chats and project memory synced.' : 'Log in to continue your projects and conversations.'}</p>
      <form onSubmit={submit} className="auth-form">
        {mode === 'register' && <label><span><UserRound size={15}/> Name</span><input autoComplete="name" value={name} onChange={e=>setName(e.target.value)} placeholder="Your name" required minLength={2}/></label>}
        <label><span><Mail size={15}/> Email</span><input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required/></label>
        <label><span><LockKeyhole size={15}/> Password</span><input type="password" autoComplete={mode==='register'?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6}/></label>
        {error && <div className="auth-error">{error}</div>}
        <button className="auth-submit" disabled={busy}>{busy?<LoaderCircle size={17} className="spin"/>:null}{mode==='register'?'Create account':'Log in'}</button>
      </form>
      <div className="auth-switch">{mode==='register'?'Already have an account?':'New to Nexora?'} <button onClick={()=>{setMode(mode==='register'?'login':'register');setError('')}}>{mode==='register'?'Log in':'Create account'}</button></div>
      <div className="auth-note">Your chats are private to your signed-in account when Firestore security rules are enabled.</div>
    </div>
  </div>;
}
