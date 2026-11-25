import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  summary?: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ReviewDialog({
  title,
  summary,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: Props) {
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    back.current?.focus();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      className="review-dialog"
      ref={dialog}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={heading}>{title}</h2>
        {summary && <p className="muted">{summary}</p>}
      </header>
      <div className="review-body">{children}</div>
      <footer>
        <button type="button" ref={back} onClick={onClose}>
          Back to selection
        </button>
        <button
          type="button"
          className={danger ? "danger-button" : "primary-button"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </footer>
    </dialog>
  );
}
