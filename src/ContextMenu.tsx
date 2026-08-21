import { useEffect, useRef } from "react";

export interface MenuItem {
  label: string;
  danger?: boolean;
  separator?: boolean;
  onClick?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // keep the menu inside the viewport
  const width = 200;
  const height = items.length * 30 + 10;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);

  return (
    <div className="context-menu" style={{ left, top }} ref={ref}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" />
        ) : (
          <button
            key={i}
            type="button"
            className={"context-menu-item" + (item.danger ? " danger" : "")}
            onClick={() => {
              onClose();
              item.onClick?.();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

export default ContextMenu;
