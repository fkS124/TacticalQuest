// Bandeau des calques, en haut de l'écran : une puce par calque connu, tap
// pour l'afficher, re-tap pour le masquer (plusieurs calques affichables à la
// fois). Le « + » ouvre une saisie en ligne pour créer un nouveau calque.
import { bus } from '../state';
import {
  createLayer,
  isLayerSelected,
  knownLayers,
  MAX_LAYER_NAME,
  toggleLayer,
} from '../map/overlays';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Deps {
  /** Petite popup de confirmation (toast). */
  notify: (text: string) => void;
}

let deps: Deps;
let adding = false; // saisie « nouveau calque » ouverte

export function initLayerBanner(d: Deps): void {
  deps = d;
  $('layer-banner').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const chip = el.closest<HTMLElement>('.layer-chip');
    if (!chip) return;
    if (chip.id === 'layer-add') {
      adding = true;
      render();
      $<HTMLInputElement>('layer-new-input').focus();
      return;
    }
    const name = chip.dataset.layer ?? '';
    const on = toggleLayer(name);
    deps.notify(
      on
        ? `Vous avez sélectionné le calque ${name}`
        : `Vous avez désélectionné le calque ${name}`,
    );
  });

  // Les calques évoluent avec les figurés reçus et les actions locales.
  bus.on('orders', render);
  bus.on('overlays', render);
  render();
}

function commitNewLayer(input: HTMLInputElement): void {
  adding = false; // avant createLayer : son émission 'overlays' re-rend le bandeau
  const name = createLayer(input.value);
  if (name) deps.notify(`Vous avez sélectionné le calque ${name}`);
  else render();
}

function render(): void {
  const banner = $('layer-banner');
  banner.replaceChildren();

  for (const name of knownLayers()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'layer-chip';
    chip.dataset.layer = name;
    const on = isLayerSelected(name);
    chip.classList.toggle('on', on);
    chip.title = on ? `Masquer le calque ${name}` : `Afficher le calque ${name}`;
    chip.textContent = name;
    banner.appendChild(chip);
  }

  if (adding) {
    const input = document.createElement('input');
    input.id = 'layer-new-input';
    input.type = 'text';
    input.maxLength = MAX_LAYER_NAME;
    input.placeholder = 'Calque…';
    input.autocomplete = 'off';
    input.enterKeyHint = 'done';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitNewLayer(input);
      } else if (e.key === 'Escape') {
        adding = false;
        render();
      }
    });
    // Retiré du DOM après validation : blur ne doit alors pas re-committer.
    input.addEventListener('blur', () => {
      if (input.isConnected) commitNewLayer(input);
    });
    banner.appendChild(input);
  } else {
    const add = document.createElement('button');
    add.type = 'button';
    add.id = 'layer-add';
    add.className = 'layer-chip';
    add.title = 'Ajouter un calque';
    add.textContent = '+';
    banner.appendChild(add);
  }
}
