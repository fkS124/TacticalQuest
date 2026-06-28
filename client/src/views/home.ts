import { DEFAULT_SIDC, CALLSIGN_REGEX, ROOM_CODE_LENGTH } from '@tq/shared/constants';
import type { ErrorCode } from '@tq/shared/protocol';
import { loadLastRoom, loadRoomHistory, removeRoomFromHistory, saveSession } from '../state';
import { createRoom, joinRoom } from '../socket';
import { SYMBOL_CHOICES, symbolSvg } from '../map/symbols';
import { enterMap } from './mapView';

const ERROR_FR: Record<ErrorCode, string> = {
  ROOM_NOT_FOUND: 'Salle introuvable. Vérifiez le code.',
  CALLSIGN_TAKEN: 'Cet indicatif est déjà utilisé dans la salle.',
  CALLSIGN_TAKEN_DISCONNECTED: 'Cet indicatif est utilisé mais déconnecté.',
  ROOM_FULL: 'La salle est pleine.',
  SERVER_FULL: 'Le serveur est saturé. Réessayez plus tard.',
  SESSION_INVALID: 'Session expirée.',
  INVALID_PAYLOAD: 'Saisie invalide.',
  RATE_LIMITED: 'Trop de salles créées récemment. Réessayez plus tard.',
  NOT_IN_ROOM: 'Vous n’êtes pas dans une salle.',
};

let selectedSidc = DEFAULT_SIDC;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function showHome(message?: string): void {
  document.body.className = 'screen-home';
  // Session expirée côté serveur : on pré-remplit code + indicatif pour un
  // rejoin en un clic plutôt que de repartir d'un formulaire vide.
  if (message) prefillFromLastRoom();
  showError(message ?? null);
  hideReplace();
  renderHistory();
}

function prefillFromLastRoom(): void {
  const last = loadLastRoom();
  if (!last) return;
  const callsign = $<HTMLInputElement>('callsign');
  const code = $<HTMLInputElement>('join-code');
  if (!callsign.value) callsign.value = last.callsign;
  if (!code.value) code.value = last.roomCode;
}

function showError(msg: string | null): void {
  const el = $('home-error');
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

/** Cache la proposition de remplacement d'un indicatif déconnecté. */
function hideReplace(): void {
  $('btn-replace').hidden = true;
}

function setBusy(busy: boolean): void {
  $('btn-create').toggleAttribute('disabled', busy);
  $('btn-join').toggleAttribute('disabled', busy);
}

function readCallsign(): string | null {
  const v = $<HTMLInputElement>('callsign').value.trim();
  if (!CALLSIGN_REGEX.test(v)) {
    showError('Indicatif invalide : 1 à 16 lettres, chiffres, espaces ou tirets.');
    return null;
  }
  return v;
}

export function initHome(): void {
  // Sélecteur de symbole APP-6
  const grid = $('symbol-grid');
  for (const { sidc, label } of SYMBOL_CHOICES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'symbol-choice';
    btn.setAttribute('role', 'option');
    if (sidc === selectedSidc) btn.classList.add('selected');
    btn.innerHTML = `${symbolSvg(sidc, 22)}<span>${label}</span>`;
    btn.addEventListener('click', () => {
      selectedSidc = sidc;
      grid.querySelectorAll('.symbol-choice').forEach((el) => el.classList.remove('selected'));
      btn.classList.add('selected');
    });
    grid.appendChild(btn);
  }

  $('btn-create').addEventListener('click', async () => {
    const callsign = readCallsign();
    if (!callsign) return;
    setBusy(true);
    showError(null);
    try {
      const res = await createRoom(callsign, selectedSidc);
      if (!res.ok) return showError(ERROR_FR[res.error]);
      saveSession({
        roomCode: res.roomCode,
        memberId: res.memberId,
        sessionToken: res.sessionToken,
        callsign,
        sidc: selectedSidc,
        isLeader: true,
      });
      enterMap();
    } catch {
      showError('Serveur injoignable. Vérifiez la connexion.');
    } finally {
      setBusy(false);
    }
  });

  $('btn-join').addEventListener('click', () => void attemptJoin());
  $('btn-replace').addEventListener('click', () => void attemptJoin(true));
  const joinInput = $<HTMLInputElement>('join-code');
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void attemptJoin();
  });
  // Toute édition rend la proposition de remplacement obsolète (autre indicatif/salle).
  joinInput.addEventListener('input', hideReplace);
  $<HTMLInputElement>('callsign').addEventListener('input', hideReplace);
  renderHistory();
}

/**
 * Rejoint la salle dont le code est saisi (ou pré-rempli par un chip d'historique).
 * `replace` reprend l'indicatif d'un membre déconnecté, après confirmation.
 */
async function attemptJoin(replace = false): Promise<void> {
  const callsign = readCallsign();
  if (!callsign) return;
  const code = $<HTMLInputElement>('join-code').value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH)
    return showError(`Le code de salle fait ${ROOM_CODE_LENGTH} caractères.`);
  setBusy(true);
  showError(null);
  hideReplace();
  try {
    const res = await joinRoom(code, callsign, selectedSidc, replace);
    if (!res.ok) {
      // Salle disparue (GC serveur) : on purge l'entrée d'historique périmée.
      if (res.error === 'ROOM_NOT_FOUND') {
        removeRoomFromHistory(code);
        renderHistory();
      }
      // Indicatif tenu par un membre déconnecté : on propose de le remplacer.
      if (res.error === 'CALLSIGN_TAKEN_DISCONNECTED') {
        showError(ERROR_FR[res.error]);
        const btn = $('btn-replace');
        btn.textContent = `Remplacer « ${callsign} » (déconnecté)`;
        btn.hidden = false;
        return;
      }
      return showError(ERROR_FR[res.error]);
    }
    saveSession({
      roomCode: res.roomCode,
      memberId: res.memberId,
      sessionToken: res.sessionToken,
      callsign,
      sidc: selectedSidc,
      isLeader: false,
    });
    enterMap();
  } catch {
    showError('Serveur injoignable. Vérifiez la connexion.');
  } finally {
    setBusy(false);
  }
}

/** Liste des salles récentes : un tap pré-remplit indicatif + code et rejoint. */
function renderHistory(): void {
  const container = $('room-history');
  const list = $('room-history-list');
  const history = loadRoomHistory();
  container.hidden = history.length === 0;
  list.replaceChildren();

  for (const entry of history) {
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'room-chip-main';
    const code = document.createElement('span');
    code.className = 'room-chip-code';
    code.textContent = entry.roomCode;
    const call = document.createElement('span');
    call.className = 'room-chip-call';
    call.textContent = entry.callsign;
    main.append(code, call);
    main.addEventListener('click', () => {
      $<HTMLInputElement>('callsign').value = entry.callsign;
      $<HTMLInputElement>('join-code').value = entry.roomCode;
      void attemptJoin();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'room-chip-remove';
    remove.setAttribute('aria-label', `Oublier la salle ${entry.roomCode}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      removeRoomFromHistory(entry.roomCode);
      renderHistory();
    });

    const chip = document.createElement('div');
    chip.className = 'room-chip';
    chip.append(main, remove);
    list.appendChild(chip);
  }
}
