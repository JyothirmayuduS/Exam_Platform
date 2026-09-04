// Shared UI kit — one button language for the whole platform.
// Formal editorial style: 2px corners, forest primary, mono labels, clear
// hover/pressed/focus affordances on every interactive control.

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { FiArrowRight, FiArrowLeft, FiPlus, FiUpload, FiX, FiMoreHorizontal } from "react-icons/fi";

/* ── Buttons ───────────────────────────────────────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type ButtonSize = "sm" | "md" | "lg";

const BTN_BASE =
  "inline-flex select-none items-center justify-center gap-2 border font-mono font-medium uppercase tracking-wider transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-forest/40 focus-visible:ring-offset-2 focus-visible:ring-offset-paper disabled:cursor-not-allowed disabled:opacity-45 active:translate-y-px";

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-forest bg-forest text-paper shadow-sm hover:bg-forest-light hover:shadow",
  secondary:
    "border-line-strong bg-paper-raised text-ink hover:border-forest hover:text-forest",
  ghost:
    "border-transparent bg-transparent text-ink-soft hover:bg-paper-raised hover:text-ink",
  danger:
    "border-alert/70 bg-alert text-paper shadow-sm hover:bg-alert/90",
  outline:
    "border-line-strong bg-transparent text-ink hover:border-forest hover:text-forest",
};

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-[9px]",
  md: "px-4 py-2.5 text-[10px]",
  lg: "px-5 py-3 text-[11px]",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  children?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", icon, iconRight, className = "", children, ...rest }, ref) => (
    <button
      ref={ref}
      className={`${BTN_BASE} ${BTN_VARIANT[variant]} ${BTN_SIZE[size]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
      {iconRight}
    </button>
  ),
);
Button.displayName = "Button";

/** Square icon-only button (table row actions, toolbars). */
export function IconButton({
  label,
  children,
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  const pad = size === "sm" ? "p-1.5" : size === "lg" ? "p-3" : "p-2.5";
  return (
    <button
      aria-label={label}
      title={label}
      className={`${BTN_BASE} ${BTN_VARIANT[variant]} ${pad} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ── Convenience icon presets (so call sites stay declarative) ─────────── */

export const ArrowRightIcon = ({ className = "text-[inherit]" }: { className?: string }) => <FiArrowRight className={className} aria-hidden />;
export const ArrowLeftIcon = ({ className = "text-[inherit]" }: { className?: string }) => <FiArrowLeft className={className} aria-hidden />;
export const PlusIcon = ({ className = "text-[inherit]" }: { className?: string }) => <FiPlus className={className} aria-hidden />;
export const UploadIcon = ({ className = "text-[inherit]" }: { className?: string }) => <FiUpload className={className} aria-hidden />;
export const CloseIcon = ({ className = "text-[inherit]" }: { className?: string }) => <FiX className={className} aria-hidden />;
export const MoreIcon = ({ className = "text-[inherit]" }: { className?: string }) => <FiMoreHorizontal className={className} aria-hidden />;

/* ── Small building blocks ─────────────────────────────────────────────── */

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-paper-raised text-ink-soft",
    green: "bg-success/10 text-success",
    amber: "bg-amber/10 text-amber",
    red: "bg-alert/10 text-alert",
    blue: "bg-forest/10 text-forest",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  detail,
  action,
  className = "",
}: {
  title: string;
  detail: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-14 text-center ${className}`}>
      <p className="font-serif text-xl text-ink">{title}</p>
      <p className="mt-2 max-w-md text-[13px] text-ink-soft">{detail}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

/** Segmented pill control — filter tabs / view toggles. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  tone = "forest",
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  tone?: "forest" | "alert";
}) {
  const active =
    tone === "alert" ? "bg-alert text-paper" : "bg-forest text-paper";
  return (
    <div className="inline-flex flex-wrap gap-px border border-line bg-paper-raised p-1" role="tablist">
      {options.map((o) => (
        <button
          key={o}
          role="tab"
          aria-selected={value === o}
          onClick={() => onChange(o)}
          className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
            value === o ? active : "text-ink-soft hover:bg-paper hover:text-ink"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}