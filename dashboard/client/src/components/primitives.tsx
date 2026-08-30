import type { ReactNode } from 'react';

export const StatusDot = ({ online, size = 'md' }: { online: boolean; size?: 'sm' | 'md' }) => (
  <span
    className={`status-dot ${online ? 'online' : 'offline'} ${size}`}
    aria-label={online ? 'Online' : 'Offline'}
  />
);

export const Meter = ({ value, tone = 'aqua' }: { value: number; tone?: string }) => (
  <div className="meter">
    {/* 3% floor keeps a sliver visible at zero so the row does not look empty. */}
    <span className={`meter-fill ${tone}`} style={{ width: `${Math.min(Math.max(value, 3), 100)}%` }} />
  </div>
);

export const PanelTitle = ({ icon, title, meta }: { icon: ReactNode; title: string; meta: string }) => (
  <div className="panel-title">
    <div>
      <span className="panel-icon">{icon}</span>
      <strong>{title}</strong>
    </div>
    <span>{meta}</span>
  </div>
);

export const Readout = ({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: string;
}) => (
  <div className="readout">
    <span className={`readout-icon ${tone}`}>{icon}</span>
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  </div>
);

/**
 * Plots a real temperature series. The original design used a fixed decorative
 * path; this keeps the same shape and stroke weight but draws what happened.
 */
export const Sparkline = ({ series }: { series: number[] }) => {
  if (series.length < 2) {
    return (
      <svg className="sparkline" viewBox="0 0 280 56" preserveAspectRatio="none">
        <line x1="0" y1="28" x2="280" y2="28" stroke="currentColor" strokeWidth="2" opacity=".25" />
      </svg>
    );
  }

  // A minimum span stops a steady temperature rendering as a full-height line.
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = Math.max(max - min, 4);
  const lo = (min + max) / 2 - span / 2;

  const points = series.map((value, i) => {
    const x = (i / (series.length - 1)) * 280;
    const y = 52 - ((value - lo) / span) * 48;
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  const line = `M${points.join(' L')}`;

  return (
    <svg className="sparkline" viewBox="0 0 280 56" preserveAspectRatio="none" aria-label="Temperature history">
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      <path d={`${line} L280 56 L0 56 Z`} fill="currentColor" opacity=".10" />
    </svg>
  );
};
