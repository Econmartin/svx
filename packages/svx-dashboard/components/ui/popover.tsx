'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * Our own Tooltip and Menu, replacing the browser's native `title` tooltips
 * and dropdowns: a frosted material, a quick scale-in from the anchor,
 * rendered in a portal so a scrolling or clipped parent (the nav) can never
 * cut them off.
 */

type Placement = 'bottom-start' | 'bottom-end' | 'bottom';

function useAnchorPosition(
  anchor: React.RefObject<HTMLElement>,
  open: boolean,
  placement: Placement,
) {
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const update = () => {
      const r = anchor.current!.getBoundingClientRect();
      const left =
        placement === 'bottom-start' ? r.left : placement === 'bottom-end' ? r.right : r.left + r.width / 2;
      setPos({ top: r.bottom + 8, left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor, open, placement]);
  return pos;
}

const shift: Record<Placement, string> = {
  'bottom-start': 'translateX(0)',
  'bottom-end': 'translateX(-100%)',
  bottom: 'translateX(-50%)',
};

// ── Tooltip ──────────────────────────────────────────────────────────────────

export function Tooltip({
  content,
  children,
  delayMs = 350,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  delayMs?: number;
}) {
  const anchor = React.useRef<HTMLElement>(null);
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>();
  const id = React.useId();
  const pos = useAnchorPosition(anchor, open, 'bottom');
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delayMs);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  React.useEffect(() => () => clearTimeout(timer.current), []);
  const child = React.cloneElement(children, {
    ref: anchor,
    'aria-describedby': open ? id : undefined,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hide,
  } as never);
  return (
    <>
      {child}
      {open &&
        pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="material-thick fixed z-[100] pointer-events-none rounded-[8px] px-2.5 py-1.5 text-[12px] leading-snug text-fg shadow-pop animate-pop-in max-w-[260px]"
            style={{ top: pos.top, left: pos.left, transform: shift.bottom }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

// ── Menu ─────────────────────────────────────────────────────────────────────

interface MenuContextValue {
  close: () => void;
}
const MenuContext = React.createContext<MenuContextValue | null>(null);

/**
 * A button that opens a menu of items. Click outside or Escape closes it;
 * ↑/↓ move between items, Home/End jump, Enter/Space activate.
 */
export function Menu({
  trigger,
  children,
  placement = 'bottom-end',
  label,
  triggerClassName,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  placement?: Placement;
  label: string;
  triggerClassName?: string;
}) {
  const anchor = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const [open, setOpen] = React.useState(false);
  const pos = useAnchorPosition(anchor as React.RefObject<HTMLElement>, open, placement);
  const id = React.useId();
  const close = React.useCallback(() => {
    setOpen(false);
    anchor.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Focus the first item once the panel is placed.
  React.useEffect(() => {
    if (open && pos) panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, pos]);

  const onPanelKey = (e: React.KeyboardEvent) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => items[(n + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') close();
      else setOpen(false);
      return;
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            setOpen(true);
            e.preventDefault();
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open &&
        pos &&
        createPortal(
          <MenuContext.Provider value={{ close: () => setOpen(false) }}>
            <div
              ref={panel}
              id={id}
              role="menu"
              aria-label={label}
              onKeyDown={onPanelKey}
              className="material-thick fixed z-[100] min-w-[220px] rounded-[12px] p-1.5 shadow-pop animate-pop-in origin-top-right"
              style={{ top: pos.top, left: pos.left, transform: shift[placement] }}
            >
              {children}
            </div>
          </MenuContext.Provider>,
          document.body,
        )}
    </>
  );
}

/** A menu row. Renders its child element (e.g. a Link) with menu semantics. */
export function MenuItem({
  children,
  active,
  className,
}: {
  children: React.ReactElement;
  active?: boolean;
  className?: string;
}) {
  const ctx = React.useContext(MenuContext);
  const child = children as React.ReactElement<{ className?: string; onClick?: (e: React.MouseEvent) => void }>;
  return React.cloneElement(child, {
    role: 'menuitem',
    tabIndex: -1,
    onClick: (e: React.MouseEvent) => {
      child.props.onClick?.(e);
      ctx?.close();
    },
    className: cn(
      'group flex w-full items-center gap-2.5 rounded-[7px] px-2.5 h-8 text-[13.5px] outline-none transition-colors',
      'text-fg hover:bg-info hover:text-white focus:bg-info focus:text-white',
      active && 'font-semibold',
      className,
      child.props.className,
    ),
  } as never);
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 mx-2 h-px bg-white/[0.1]" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-muted">{children}</div>;
}
