import { useEffect, useRef, useState } from 'react';
import { askPermission, setAlertDefault, useAlertPermission, useAlertSettings, type AlertPermission } from './desktopNotify';
import { BellIcon, BellOffIcon } from './icons';

/** Why alerts can't show, if they can't. */
export function permissionNote(p: AlertPermission): string | null {
  if (p === 'unsupported') return "This browser doesn't support desktop alerts.";
  if (p === 'denied') return "The browser blocks alerts for this site. Allow them in the site's settings (the icon left of the address).";
  if (p === 'default') return "The browser hasn't been asked for permission yet.";
  return null;
}

/** The sidebar's bell: the per-browser defaults for desktop alerts. Agents override them in their header menu. */
export function AlertsMenu() {
  const s = useAlertSettings();
  const permission = useAlertPermission();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const on = permission === 'granted' && (s.chats || s.experts || Object.values(s.agents).some(Boolean));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close, true);
    };
  }, [open]);

  const note = permissionNote(permission);
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className="icon-button"
        title="Desktop alerts"
        aria-label="Desktop alerts"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {on ? <BellIcon size={16} /> : <BellOffIcon size={16} />}
      </button>
      {open && (
        <div className="model-popover alerts-popover" role="dialog" aria-label="Desktop alerts">
          <div className="model-section">Desktop alerts</div>
          <p className="alerts-intro">
            A system notification when a turn ends or something needs you (a permission, questions, a track plan), while this window is in the background.
          </p>
          <label className="cache-check">
            <input type="checkbox" checked={s.chats} disabled={permission === 'unsupported'} onChange={(e) => setAlertDefault('chats', e.target.checked)} />
            <span>
              <span className="cache-check-name">Chats</span>
              <span className="model-option-hint">On by default</span>
            </span>
          </label>
          <label className="cache-check">
            <input type="checkbox" checked={s.experts} disabled={permission === 'unsupported'} onChange={(e) => setAlertDefault('experts', e.target.checked)} />
            <span>
              <span className="cache-check-name">Experts</span>
              <span className="model-option-hint">Off by default</span>
            </span>
          </label>
          {note && (
            <div className="alerts-permission">
              {note}
              {permission === 'default' && (
                <button className="link-button" onClick={() => void askPermission()}>
                  Allow alerts
                </button>
              )}
            </div>
          )}
          <div className="model-note">Each agent's ⋯ menu turns its own alerts on or off. Saved in this browser only.</div>
        </div>
      )}
    </div>
  );
}
