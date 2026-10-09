import { useEffect, useRef, useState } from "react";

/** Opens an empty, nearly full-screen panel from the project task workspace. */
export function WorkspaceDrawer() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return <>
    <button className="workspace-drawer-toggle" type="button" aria-label="Open workspace panel" title="Open panel" aria-expanded={open} aria-controls="workspace-drawer" onClick={() => { setClosing(false); setOpen(true); }}><span aria-hidden="true">›</span></button>
    <dialog ref={dialog} id="workspace-drawer" className={`workspace-drawer${closing ? " closing" : ""}`} aria-label="Workspace panel" onClose={() => { setOpen(false); setClosing(false); }} onCancel={event => { event.preventDefault(); setClosing(true); }} onClick={event => { if (event.target === dialog.current) setClosing(true); }} onAnimationEnd={event => { if (closing && event.target === dialog.current) setOpen(false); }}>
      <div className="workspace-drawer-surface">
        <button className="workspace-drawer-close" type="button" aria-label="Close workspace panel" title="Close panel" onClick={() => setClosing(true)}><span aria-hidden="true">‹</span></button>
      </div>
    </dialog>
  </>;
}
