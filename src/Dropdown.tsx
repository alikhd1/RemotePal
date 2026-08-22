// Themed replacements for <select> and <input list=…>. Native popups
// are drawn by the OS, so they ignore the app theme entirely — these
// render their own list instead. The list is portalled to <body> so it
// escapes scrolling/clipping ancestors (modal body, tab bar).

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";

export interface Option {
  value: string;
  label: string;
  icon?: ReactNode;
  /** one line under the label in the list; the trigger stays compact */
  description?: string;
}

const GAP = 4;
const EDGE = 8;
const MIN_SPACE = 150;

/** Pins a fixed-position popup to its trigger, flipping up when tight. */
function useAnchored(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  align: "left" | "right",
  minWidth: number,
) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.max(r.width, minWidth);
      const rawLeft = align === "right" ? r.right - width : r.left;
      const spaceBelow = window.innerHeight - r.bottom - GAP - EDGE;
      const spaceAbove = r.top - GAP - EDGE;
      const below = spaceBelow >= MIN_SPACE || spaceBelow >= spaceAbove;
      setStyle({
        position: "fixed",
        width,
        left: Math.max(EDGE, Math.min(rawLeft, window.innerWidth - width - EDGE)),
        maxHeight: Math.min(288, Math.max(120, below ? spaceBelow : spaceAbove)),
        ...(below
          ? { top: r.bottom + GAP }
          : { bottom: window.innerHeight - r.top + GAP }),
      });
    };
    place();
    // capture: also follows scrolling of any ancestor container
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, minWidth, triggerRef]);

  return style;
}

/** Close on outside mousedown, focus leaving, or the window blurring. */
function useDismiss(
  open: boolean,
  close: () => void,
  anchorRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
) {
  // read through a ref so the listeners are bound once per open, not
  // re-bound on every render
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) =>
      !anchorRef.current?.contains(target as Node) &&
      !popupRef.current?.contains(target as Node);
    const onDown = (e: MouseEvent) => {
      if (outside(e.target)) closeRef.current();
    };
    // focus moving elsewhere (Tab, another dropdown) must close this one
    const onFocusIn = (e: FocusEvent) => {
      if (outside(e.target)) closeRef.current();
    };
    const onBlur = () => closeRef.current();
    window.addEventListener("mousedown", onDown);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, anchorRef, popupRef]);
}

function useScrollHighlightIntoView(
  popupRef: RefObject<HTMLElement | null>,
  index: number,
  open: boolean,
) {
  useEffect(() => {
    if (!open) return;
    popupRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index, open, popupRef]);
}

interface OptionListProps {
  options: Option[];
  highlight: number;
  selected: string;
  listId: string;
  onPick: (value: string) => void;
  onHover: (index: number) => void;
  empty?: string;
}

function OptionList({
  options,
  highlight,
  selected,
  listId,
  onPick,
  onHover,
  empty,
}: OptionListProps) {
  if (options.length === 0) {
    return <div className="dd-empty">{empty ?? "No matches"}</div>;
  }
  return (
    <>
      {options.map((o, i) => (
        <div
          key={o.value}
          id={`${listId}-${i}`}
          data-index={i}
          role="option"
          aria-selected={o.value === selected}
          className={
            "dd-option" +
            (i === highlight ? " active" : "") +
            (o.value === selected ? " selected" : "")
          }
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus on the trigger/input
            onPick(o.value);
          }}
        >
          {o.icon && <span className="dd-option-icon">{o.icon}</span>}
          {o.description ? (
            <span className="dd-option-text">
              <span className="dd-option-label">{o.label}</span>
              <span className="dd-option-desc">{o.description}</span>
            </span>
          ) : (
            <span className="dd-option-label">{o.label}</span>
          )}
        </div>
      ))}
    </>
  );
}

interface SelectProps {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  /** shown when the value matches no option */
  placeholder?: string;
  title?: string;
  size?: "sm" | "md";
  align?: "left" | "right";
  minWidth?: number;
  id?: string;
}

/** Themed <select>: value is always one of `options`. */
export function Select({
  value,
  options,
  onChange,
  placeholder = "Select…",
  title,
  size = "md",
  align = "left",
  minWidth = 170,
  id,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();

  const style = useAnchored(open, triggerRef, align, minWidth);
  useDismiss(open, () => setOpen(false), triggerRef, popupRef);
  useScrollHighlightIntoView(popupRef, highlight, open);

  const current = options.find((o) => o.value === value) ?? null;

  function openAt() {
    setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function pick(next: string) {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openAt();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + options.length) % options.length);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (options[highlight]) pick(options[highlight].value);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key.length === 1) {
      // type-ahead: repeated keystrokes within a second extend the query
      const now = Date.now();
      typed.current.text =
        now - typed.current.at > 1000 ? e.key : typed.current.text + e.key;
      typed.current.at = now;
      const query = typed.current.text.toLowerCase();
      const hit = options.findIndex((o) =>
        o.label.toLowerCase().startsWith(query),
      );
      if (hit >= 0) setHighlight(hit);
    }
  }

  return (
    <>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className={"dd-trigger" + (size === "sm" ? " sm" : "") + (open ? " open" : "")}
        title={title}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
        onClick={() => (open ? setOpen(false) : openAt())}
        onKeyDown={onKeyDown}
      >
        {current?.icon && <span className="dd-trigger-icon">{current.icon}</span>}
        <span className={"dd-trigger-label" + (current ? "" : " dim")}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={size === "sm" ? 12 : 14} className="dd-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            id={listId}
            ref={popupRef}
            role="listbox"
            className="dd-popup"
            style={style}
          >
            <OptionList
              options={options}
              highlight={highlight}
              selected={value}
              listId={listId}
              onPick={pick}
              onHover={setHighlight}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

interface ComboProps {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** message when nothing matches what was typed */
  empty?: string;
  id?: string;
}

/** Themed <input list=…>: free text plus a filtered suggestion list. */
export function Combo({
  value,
  options,
  onChange,
  placeholder,
  empty,
  id,
}: ComboProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const style = useAnchored(open, wrapRef, "left", 170);
  useDismiss(open, () => setOpen(false), wrapRef, popupRef);
  useScrollHighlightIntoView(popupRef, highlight, open);

  const query = value.trim().toLowerCase();
  // an exact hit means the field is "done" — show everything again
  const exact = options.some((o) => o.value.toLowerCase() === query);
  const matches =
    query && !exact
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(query) ||
            o.value.toLowerCase().includes(query),
        )
      : options;

  function pick(next: string) {
    onChange(next);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlight(0);
        return;
      }
      if (matches.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      // only steal Enter when a suggestion is actually highlighted
      if (open && highlight >= 0 && matches[highlight]) {
        e.preventDefault();
        pick(matches[highlight].value);
      } else {
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <div className="dd-combo" ref={wrapRef}>
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && highlight >= 0 ? `${listId}-${highlight}` : undefined
        }
        onChange={(e) => {
          onChange(e.currentTarget.value);
          setHighlight(-1);
          setOpen(true);
        }}
        // click, not focus: tabbing through the form shouldn't flash
        // suggestion lists open (matches how a native datalist behaves)
        onClick={() => options.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {options.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          className="dd-combo-toggle"
          title="Show suggestions"
          onClick={() => {
            setHighlight(-1);
            setOpen((o) => !o);
          }}
        >
          <ChevronDown size={14} />
        </button>
      )}
      {open &&
        createPortal(
          <div
            id={listId}
            ref={popupRef}
            role="listbox"
            className="dd-popup"
            style={style}
          >
            <OptionList
              options={matches}
              highlight={highlight}
              selected={value}
              listId={listId}
              onPick={pick}
              onHover={setHighlight}
              empty={empty}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
