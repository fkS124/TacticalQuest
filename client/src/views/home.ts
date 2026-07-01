import { DEFAULT_ROLE, CALLSIGN_REGEX, ROOM_CODE_LENGTH } from '@tq/shared/constants';
import type { ErrorCode } from '@tq/shared/protocol';
import { loadLastRoom, loadRoomHistory, removeRoomFromHistory, saveSession } from '../state';
import { createRoom, joinRoom } from '../socket';
import { ROLE_KINDS, kindFigure, roleFigure, parseRole, roleDesignation, type RoleKind } from '../map/symbols';
import { enterMap } from './mapView';

const ERROR_FR: Record<ErrorCode, string> = {
  ROOM_NOT_FOUND: 'Salle introuvable. Vérifiez le code.',
  CALLSIGN_TAKEN: 'Cet indicatif est déjà utilisé dans la salle.',
  CALLSIGN_TAKEN_DISCONNECTED: 'Cet indicatif est utilisé mais déconnecté.',
  ROOM_FULL: 'La salle est pleine.',
  SERVER_FULL: 'Le serveur est saturé. Réessayez plus tard.',
  SESSION_INVALID: 'Session expirée.',
  INVALID_PAYLOAD: 'Saisie invalide.',
  POST_TAKEN: 'Ce poste est déjà occupé dans la salle.',
  POST_TAKEN_DISCONNECTED: 'Ce poste est occupé mais déconnecté.',
  RATE_LIMITED: 'Trop de salles créées récemment. Réessayez plus tard.',
  NOT_IN_ROOM: 'Vous n’êtes pas dans une salle.',
};

// Sélection courante dans l'arbre de commandement. Des valeurs par défaut sur
// section/groupe/équipe garantissent un `role` toujours valide dès qu'un niveau
// est choisi (cf. selectedRole).
let level: RoleKind = parseRole(DEFAULT_ROLE).kind;
let section = 1;
let group = 1;
let team: 'A' | 'B' = 'A';

function selectedRole(): string {
  switch (level) {
    case 'CDS':
      return `CDS:${section}`;
    case 'CDG':
      return `CDG:${section}:${group}`;
    case 'CDE':
      return `CDE:${section}:${group}:${team}`;
    default:
      return level; // CDU, GV : pas de sous-niveau
  }
}

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

/** Une rangée de boutons segmentés (section / groupe / équipe). */
function renderSegment<T extends number | string>(
  host: HTMLElement,
  label: string,
  show: boolean,
  values: readonly T[],
  desig: (v: T) => string,
  current: T,
  onPick: (v: T) => void,
): void {
  host.hidden = !show;
  host.innerHTML = '';
  if (!show) return;
  const cap = document.createElement('span');
  cap.className = 'role-sub-label';
  cap.textContent = label;
  const row = document.createElement('div');
  row.className = 'role-seg';
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'role-seg-btn';
    b.textContent = desig(v);
    if (v === current) b.classList.add('selected');
    b.addEventListener('click', () => onPick(v));
    row.appendChild(b);
  }
  host.append(cap, row);
}

/** Reflète la sélection courante : niveau actif, sous-niveaux, aperçu. */
function renderPicker(): void {
  $('role-levels')
    .querySelectorAll<HTMLElement>('.role-level')
    .forEach((el) => el.classList.toggle('selected', el.dataset.kind === level));

  const needSection = level === 'CDS' || level === 'CDG' || level === 'CDE';
  const needGroup = level === 'CDG' || level === 'CDE';
  const needTeam = level === 'CDE';

  renderSegment($('role-section'), 'Section', needSection, [1, 2, 3] as const, (s) => String(s * 10), section, (s) => {
    section = s;
    renderPicker();
  });
  renderSegment($('role-group'), 'Groupe', needGroup, [1, 2, 3] as const, (g) => `${section}${g}`, group, (g) => {
    group = g;
    renderPicker();
  });
  renderSegment($('role-team'), 'Équipe', needTeam, ['A', 'B'] as const, (t) => `${section}${group}${t}`, team, (t) => {
    team = t;
    renderPicker();
  });

  const role = selectedRole();
  const full = ROLE_KINDS.find((k) => k.kind === level)!.full;
  const desig = roleDesignation(role);
  $('role-preview').innerHTML =
    `${roleFigure(role, 34)}<span class="role-preview-label">${full}${desig ? ` — ${desig}` : ''}</span>`;
}

function initRolePicker(): void {
  const levels = $('role-levels');
  levels.innerHTML = '';
  for (const { kind, full } of ROLE_KINDS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'role-level';
    btn.dataset.kind = kind;
    btn.title = full;
    btn.setAttribute('role', 'option');
    btn.innerHTML = `${kindFigure(kind, 24)}<span>${kind}</span>`;
    btn.addEventListener('click', () => {
      level = kind;
      renderPicker();
    });
    levels.appendChild(btn);
  }
  renderPicker();
}

export function initHome(): void {
  initRolePicker();

  $('btn-create').addEventListener('click', async () => {
    const callsign = readCallsign();
    if (!callsign) return;
    setBusy(true);
    showError(null);
    try {
      const role = selectedRole();
      const res = await createRoom(callsign, role);
      if (!res.ok) return showError(ERROR_FR[res.error]);
      saveSession({
        roomCode: res.roomCode,
        memberId: res.memberId,
        sessionToken: res.sessionToken,
        callsign,
        role,
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
 * `replace` reprend l'indicatif OU le poste d'un membre déconnecté, après confirmation.
 */
async function attemptJoin(replace = false): Promise<void> {
  const callsign = readCallsign();
  if (!callsign) return;
  const code = $<HTMLInputElement>('join-code').value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH)
    return showError(`Le code de salle fait ${ROOM_CODE_LENGTH} caractères.`);
  const role = selectedRole();
  setBusy(true);
  showError(null);
  hideReplace();
  try {
    const res = await joinRoom(code, callsign, role, replace);
    if (!res.ok) {
      // Salle disparue (GC serveur) : on purge l'entrée d'historique périmée.
      if (res.error === 'ROOM_NOT_FOUND') {
        removeRoomFromHistory(code);
        renderHistory();
      }
      // Indicatif ou poste tenu par un membre déconnecté : on propose de le remplacer.
      if (res.error === 'CALLSIGN_TAKEN_DISCONNECTED' || res.error === 'POST_TAKEN_DISCONNECTED') {
        showError(ERROR_FR[res.error]);
        const what =
          res.error === 'POST_TAKEN_DISCONNECTED'
            ? `le poste ${roleDesignation(role) || parseRole(role).kind}`
            : `« ${callsign} »`;
        const btn = $('btn-replace');
        btn.textContent = `Remplacer ${what} (déconnecté)`;
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
      role,
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
