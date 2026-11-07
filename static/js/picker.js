// A small accessible dropdown ("picker") used for the model, persona and effort
// selectors. All pickers share one popover element; only one is open at a time.

import { icon } from "./icons.js";
import { escapeHtml } from "./markdown.js";

const popover = document.getElementById("popover");
let openPicker = null;

function closeOpen() {
  if (openPicker) openPicker.close();
}

document.addEventListener("pointerdown", (e) => {
  if (!openPicker) return;
  if (popover.contains(e.target) || openPicker.button.contains(e.target)) return;
  closeOpen();
});
window.addEventListener("resize", closeOpen);
window.addEventListener("blur", closeOpen);

export function isPickerOpen() {
  return openPicker !== null;
}

export class Picker {
  /**
   * @param {HTMLButtonElement} button
   * @param {{items: Array<{id:string,label:string,description?:string,iconHtml?:string}>,
   *          value: string, onChange: (id:string)=>void,
   *          renderButton: (item:object)=>string}} options
   */
  constructor(button, { items, value, onChange, renderButton }) {
    this.button = button;
    this.items = items;
    this.value = value;
    this.onChange = onChange;
    this.renderButton = renderButton;
    this.button.addEventListener("click", () => (openPicker === this ? this.close() : this.open()));
    this.button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.open();
      }
    });
    this.renderButtonContent();
  }

  get selected() {
    return this.items.find((i) => i.id === this.value) || this.items[0];
  }

  setValue(value) {
    this.value = value;
    this.renderButtonContent();
  }

  renderButtonContent() {
    const item = this.selected;
    if (!item) return;
    this.button.innerHTML = `${this.renderButton(item)}${icon("chevronDown")}`;
    this.button.title = item.description ? `${item.label} - ${item.description}` : item.label;
  }

  open() {
    closeOpen();
    openPicker = this;
    this.button.setAttribute("aria-expanded", "true");
    popover.innerHTML = this.items
      .map(
        (item) => `
        <button type="button" class="popover-item" role="option" data-id="${escapeHtml(item.id)}"
                aria-selected="${item.id === this.value}">
          <span class="pi-icon">${item.iconHtml || ""}</span>
          <span class="pi-text">
            <span class="pi-label">${escapeHtml(item.label)}</span>
            ${item.description ? `<span class="pi-desc">${escapeHtml(item.description)}</span>` : ""}
          </span>
          <span class="pi-check">${icon("check")}</span>
        </button>`,
      )
      .join("");
    popover.hidden = false;
    this.position();

    popover.querySelectorAll(".popover-item").forEach((el) => {
      el.addEventListener("click", () => this.choose(el.dataset.id));
    });
    popover.onkeydown = (e) => this.onKey(e);
    const current = popover.querySelector('[aria-selected="true"]') || popover.querySelector(".popover-item");
    current?.focus();
  }

  position() {
    const rect = this.button.getBoundingClientRect();
    const pop = popover.getBoundingClientRect();
    const margin = 8;
    let left = Math.min(rect.left, window.innerWidth - pop.width - margin);
    left = Math.max(margin, left);
    const spaceBelow = window.innerHeight - rect.bottom;
    const top = spaceBelow > pop.height + margin ? rect.bottom + 6 : Math.max(margin, rect.top - pop.height - 6);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  onKey(e) {
    const items = [...popover.querySelectorAll(".popover-item")];
    const idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
      this.button.focus();
    } else if (e.key === "Tab") {
      this.close();
    }
  }

  choose(id) {
    this.setValue(id);
    this.close();
    this.button.focus();
    this.onChange(id);
  }

  close() {
    if (openPicker !== this) return;
    openPicker = null;
    popover.hidden = true;
    popover.innerHTML = "";
    popover.onkeydown = null;
    this.button.setAttribute("aria-expanded", "false");
  }
}
