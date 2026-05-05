'use client';
/**
 * Admin — Chat (/admin/chat)
 * Left panel: room list with last message preview and unread badge.
 * Right panel: message thread with auto-scroll and 10s polling.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminGet, adminPost } from '../../../lib/adminApi';

interface ChatRoom {
  id:              string;
  site_id:         string;
  site_name:       string;
  guard_id:        string;
  guard_name:      string;
  last_message:    string | null;
  last_message_at: string | null;
  unread_count:    number;
}

interface ChatMessage {
  id:          string;
  room_id:     string;
  sender_role: 'admin' | 'guard';
  sender_id:   string;
  message:     string;
  created_at:  string;
}

interface Guard { id: string; name: string; badge_number: string; }
interface Site  { id: string; name: string; }

function fmtTs(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export default function ChatPage() {
  const [rooms,      setRooms]      = useState<ChatRoom[]>([]);
  const [messages,   setMessages]   = useState<ChatMessage[]>([]);
  const [selected,   setSelected]   = useState<ChatRoom | null>(null);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [loadingMsgs,  setLoadingMsgs]  = useState(false);
  const [sending,    setSending]    = useState(false);
  const [text,       setText]       = useState('');
  const [error,      setError]      = useState('');

  // New chat modal
  const [showNewChat, setShowNewChat] = useState(false);
  const [guards,   setGuards]   = useState<Guard[]>([]);
  const [sites,    setSites]    = useState<Site[]>([]);
  const [newGuard, setNewGuard] = useState('');
  const [newSite,  setNewSite]  = useState('');
  const [creating, setCreating] = useState('');

  const bottomRef  = useRef<HTMLDivElement>(null);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Load rooms ────────────────────────────────────────────────────────
  const loadRooms = useCallback(async () => {
    try {
      const data = await adminGet<ChatRoom[]>('/api/chat/rooms');
      setRooms(data);
    } catch (e: any) { setError(e.message); }
    finally { setLoadingRooms(false); }
  }, []);

  useEffect(() => { loadRooms(); }, [loadRooms]);

  // ── Load messages for selected room ───────────────────────────────────
  const loadMessages = useCallback(async (roomId: string, silent = false) => {
    if (!silent) setLoadingMsgs(true);
    try {
      const data = await adminGet<ChatMessage[]>(`/api/chat/rooms/${roomId}/messages`);
      setMessages(data);
    } catch { /* silent */ }
    finally { if (!silent) setLoadingMsgs(false); }
  }, []);

  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    loadMessages(selected.id);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      loadMessages(selected.id, true);
      loadRooms();
    }, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [selected, loadMessages, loadRooms]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message ──────────────────────────────────────────────────────
  async function sendMessage() {
    if (!text.trim() || !selected || sending) return;
    setSending(true);
    try {
      const msg = await adminPost<ChatMessage>(`/api/chat/rooms/${selected.id}/messages`, { message: text.trim() });
      setMessages((prev) => [...prev, msg]);
      setText('');
      loadRooms();
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  // ── Create new chat room ───────────────────────────────────────────────
  async function loadGuardsSites() {
    const [g, s] = await Promise.all([adminGet<Guard[]>('/api/guards'), adminGet<Site[]>('/api/sites')]);
    setGuards(g); setSites(s);
  }

  function openNewChat() {
    setNewGuard(''); setNewSite(''); setCreating('');
    loadGuardsSites();
    setShowNewChat(true);
  }

  async function createRoom() {
    if (!newGuard || !newSite) { setCreating('Select both a guard and a site'); return; }
    setCreating('Creating…');
    try {
      const room = await adminPost<ChatRoom>('/api/chat/rooms', { site_id: newSite, guard_id: newGuard });
      await loadRooms();
      setShowNewChat(false);
      // Find and select the created room
      setSelected(room);
    } catch (e: any) { setCreating(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">CHAT</h1>
        <button
          onClick={openNewChat}
          className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
        >
          + NEW CHAT
        </button>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* ── Two-panel layout ──────────────────────────────────────────── */}
      <div className="flex gap-4 h-[calc(100vh-200px)] min-h-[500px]">

        {/* Left panel — room list */}
        <div className="w-80 shrink-0 bg-[#0F1E35] border border-[#1A3050] rounded-xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-[#1A3050]">
            <p className="text-gray-500 text-xs tracking-widest">CONVERSATIONS</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingRooms ? (
              <p className="text-gray-500 text-sm p-4">Loading…</p>
            ) : rooms.length === 0 ? (
              <div className="p-4 text-center">
                <p className="text-gray-500 text-sm">No chats yet.</p>
                <p className="text-gray-600 text-xs mt-1">Click "+ NEW CHAT" to start one.</p>
              </div>
            ) : (
              rooms.map((room) => (
                <button
                  key={room.id}
                  onClick={() => setSelected(room)}
                  className={`w-full text-left px-4 py-3 border-b border-[#1A3050] transition-colors hover:bg-[#0B1526] ${
                    selected?.id === room.id ? 'bg-[#0B1526] border-l-2 border-l-[#00C8FF]' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-white text-sm font-medium truncate">{room.guard_name}</p>
                      <p className="text-gray-500 text-xs truncate">{room.site_name}</p>
                      {room.last_message && (
                        <p className="text-gray-600 text-xs mt-1 truncate">{room.last_message}</p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-gray-600 text-xs">{fmtTs(room.last_message_at)}</span>
                      {room.unread_count > 0 && (
                        <span className="bg-[#00C8FF] text-[#070F1E] text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                          {Math.min(room.unread_count, 99)}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right panel — message thread */}
        <div className="flex-1 bg-[#0F1E35] border border-[#1A3050] rounded-xl flex flex-col overflow-hidden">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <p className="text-4xl mb-3">💬</p>
                <p className="text-gray-400 text-sm">Select a conversation</p>
                <p className="text-gray-600 text-xs mt-1">or create a new one</p>
              </div>
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div className="px-5 py-3 border-b border-[#1A3050] flex items-center gap-3">
                <div>
                  <p className="text-white font-semibold text-sm">{selected.guard_name}</p>
                  <p className="text-gray-500 text-xs">{selected.site_name}</p>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {loadingMsgs ? (
                  <div className="text-center text-gray-500 text-sm py-8">Loading messages…</div>
                ) : messages.length === 0 ? (
                  <div className="text-center text-gray-600 text-sm py-8">No messages yet. Say hello!</div>
                ) : (
                  messages.map((msg) => {
                    const isAdmin = msg.sender_role === 'admin';
                    return (
                      <div key={msg.id} className={`flex ${isAdmin ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                          isAdmin
                            ? 'bg-[#F5A623] text-gray-900 rounded-tr-sm'
                            : 'bg-[#0B1526] border border-[#1A3050] text-gray-200 rounded-tl-sm'
                        }`}>
                          <p className="text-sm leading-relaxed break-words">{msg.message}</p>
                          <p className={`text-xs mt-1 ${isAdmin ? 'text-gray-800/70' : 'text-gray-500'}`}>
                            {new Date(msg.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <div className="px-4 py-3 border-t border-[#1A3050] flex gap-3">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={handleKey}
                  placeholder="Type a message… (Enter to send)"
                  rows={1}
                  className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-xl px-4 py-2.5 text-gray-200 text-sm resize-none focus:outline-none focus:border-[#00C8FF] placeholder-gray-600"
                  style={{ minHeight: 40, maxHeight: 120 }}
                />
                <button
                  onClick={sendMessage}
                  disabled={sending || !text.trim()}
                  className="bg-amber-400 text-gray-900 font-bold tracking-widest text-xs px-4 py-2 rounded-xl hover:bg-amber-300 disabled:opacity-40 transition-colors"
                >
                  {sending ? '…' : 'SEND'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── New Chat Modal ─────────────────────────────────────────────── */}
      {showNewChat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">NEW CHAT</h2>
              <button onClick={() => setShowNewChat(false)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {typeof creating === 'string' && creating && creating !== 'Creating…' && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{creating}</div>
            )}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-amber-400">*</span></label>
                <select value={newGuard} onChange={(e) => setNewGuard(e.target.value)}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
                  <option value="">Select guard…</option>
                  {guards.map((g) => <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE <span className="text-amber-400">*</span></label>
                <select value={newSite} onChange={(e) => setNewSite(e.target.value)}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
                  <option value="">Select site…</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowNewChat(false)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createRoom} disabled={creating === 'Creating…'} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {creating === 'Creating…' ? 'CREATING…' : 'START CHAT'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
