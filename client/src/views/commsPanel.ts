// Comms : chat libre de la salle. Chacun peut envoyer des messages texte ;
// ils transitent comme des ordres `text` (transport optimiste + file hors-ligne).
import { state } from '../state';
import { sendOrder } from '../socket';
import { uid, escapeHtml } from '../util';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Longueur max d'un message (borne aussi côté serveur via MAX_ORDER_BYTES). */
const MAX_MESSAGE_LEN = 500;

interface Deps {
  notify: (text: string) => void;
}

interface ChatMessage {
  id: string;
  authorId: string;
  ts: number;
  body: string;
}

let deps: Deps;
// Messages déjà vus (pour ne notifier qu'une fois) et compteur de non-lus.
const seen = new Set<string>();
let unread = 0;

export function initCommsPanel(d: Deps): void {
  deps = d;
  $('btn-comms').addEventListener('click', () => toggleComms());
  $('comms-close').addEventListener('click', () => closeComms());
  $('comms-send').addEventListener('click', sendChat);
  const input = $<HTMLInputElement>('comms-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });
}

function deriveMessages(): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const o of state.orders.values()) {
    if (o.payload.kind !== 'text') continue;
    out.push({ id: o.id, authorId: o.authorId, ts: o.ts, body: o.payload.body });
  }
  out.sort((a, b) => a.ts - b.ts); // ordre chronologique (chat)
  return out;
}

export function toggleComms(): void {
  if ($('comms-panel').hidden) openComms();
  else closeComms();
}

export function openComms(): void {
  $('comms-panel').hidden = false;
  unread = 0;
  renderComms();
  attachViewport();
  scrollToBottom();
  $<HTMLInputElement>('comms-input').focus();
}

export function closeComms(): void {
  $('comms-panel').hidden = true;
  detachViewport();
}

// --- clavier mobile : suivre le viewport visible ---
// Quand le clavier s'ouvre, la fenêtre visible (visualViewport) rétrécit alors
// que la fenêtre de mise en page ne bouge pas : un panneau ancré en bas reste
// derrière le clavier (dernier message + saisie masqués). On colle donc le
// panneau à la zone réellement visible, et on redescend au dernier message.
let vvApply: (() => void) | null = null;

function attachViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const panel = $('comms-panel');
  vvApply = () => {
    panel.style.top = `${vv.offsetTop}px`;
    panel.style.height = `${vv.height}px`;
    panel.style.bottom = 'auto';
    scrollToBottom();
  };
  vvApply();
  vv.addEventListener('resize', vvApply);
  vv.addEventListener('scroll', vvApply);
}

function detachViewport(): void {
  const panel = $('comms-panel');
  panel.style.top = '';
  panel.style.height = '';
  panel.style.bottom = '';
  const vv = window.visualViewport;
  if (vv && vvApply) {
    vv.removeEventListener('resize', vvApply);
    vv.removeEventListener('scroll', vvApply);
  }
  vvApply = null;
}

function isOpen(): boolean {
  return !$('comms-panel').hidden;
}

function sendChat(): void {
  const session = state.session;
  if (!session) return;
  const input = $<HTMLInputElement>('comms-input');
  const body = input.value.trim().slice(0, MAX_MESSAGE_LEN);
  if (!body) return;
  sendOrder({
    id: uid(),
    authorId: session.memberId,
    ts: Date.now(),
    kind: 'text',
    payload: { kind: 'text', body },
  });
  input.value = '';
  // sendOrder applique l'ordre et émet bus('orders') → renderComms ; on garde
  // juste le focus et on défile en bas.
  input.focus();
  scrollToBottom();
}

// --- rendu ---

export function renderComms(): void {
  if (!isOpen()) return;
  const list = $('comms-messages');
  const wasAtBottom = isScrolledToBottom();
  list.innerHTML = '';
  const messages = deriveMessages();
  if (messages.length === 0) {
    list.innerHTML = '<li class="comms-empty">Aucun message. Lancez les comms.</li>';
    return;
  }
  const me = state.session?.memberId;
  for (const m of messages) {
    seen.add(m.id);
    list.appendChild(messageItem(m, m.authorId === me));
  }
  if (wasAtBottom) scrollToBottom();
}

function messageItem(m: ChatMessage, mine: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `comms-msg${mine ? ' mine' : ''}`;
  li.innerHTML =
    `<span class="cm-head"><b>${escapeHtml(callsign(m.authorId))}</b>` +
    `<span class="cm-time">${time(m.ts)}</span></span>` +
    `<span class="cm-body">${escapeHtml(m.body)}</span>`;
  return li;
}

function isScrolledToBottom(): boolean {
  const list = $('comms-messages');
  return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
}

function scrollToBottom(): void {
  const list = $('comms-messages');
  list.scrollTop = list.scrollHeight;
}

// --- badge + notifications ---

/** Messages reçus non encore lus (panneau fermé). */
export function unreadCommsCount(): number {
  return unread;
}

/**
 * Notifie (toast + vibration) à chaque nouveau message d'un autre membre, et
 * incrémente le compteur de non-lus tant que le panneau est fermé.
 */
export function checkIncomingMessages(): void {
  const me = state.session?.memberId;
  if (!me) return;
  for (const m of deriveMessages()) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.authorId === me) continue; // nos propres messages : déjà vus
    if (isOpen()) continue; // lu en direct, pas de notif
    unread++;
    deps.notify(`${callsign(m.authorId)} : ${m.body}`);
    if ('vibrate' in navigator) navigator.vibrate?.([80, 50, 80]);
  }
}

export function resetCommsNotifications(): void {
  seen.clear();
  unread = 0;
}

// --- utilitaires ---

function callsign(memberId: string): string {
  const m = state.members.get(memberId);
  if (m) return m.callsign;
  if (memberId === state.session?.memberId) return state.session.callsign;
  return 'inconnu';
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
