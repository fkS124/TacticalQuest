import { DEFAULT_SIDC, CALLSIGN_REGEX } from '@tq/shared/constants';
import type { ErrorCode } from '@tq/shared/protocol';
import { saveSession } from '../state';
import { createRoom, joinRoom } from '../socket';
import { SYMBOL_CHOICES, symbolSvg } from '../map/symbols';
import { enterMap } from './mapView';

const ERROR_FR: Record<ErrorCode, string> = {
  ROOM_NOT_FOUND: 'Salle introuvable. Vérifiez le code.',
  CALLSIGN_TAKEN: 'Cet indicatif est déjà utilisé dans la salle.',
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
  showError(message ?? null);
}

function showError(msg: string | null): void {
  const el = $('home-error');
  el.hidden = !msg;
  el.textContent = msg ?? '';
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

  const joinInput = $<HTMLInputElement>('join-code');
  const doJoin = async () => {
    const callsign = readCallsign();
    if (!callsign) return;
    const code = joinInput.value.trim().toUpperCase();
    if (code.length !== 6) return showError('Le code de salle fait 6 caractères.');
    setBusy(true);
    showError(null);
    try {
      const res = await joinRoom(code, callsign, selectedSidc);
      if (!res.ok) return showError(ERROR_FR[res.error]);
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
  };
  $('btn-join').addEventListener('click', doJoin);
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doJoin();
  });
}
