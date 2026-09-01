import { Chevron, Gauge } from './icons';
import type { AppTile } from '../../../shared/fleet';
import { StatusDot } from './primitives';

/** Tile colours cycle so a newly added app gets one without being configured. */
const ACCENTS = ['purple', 'blue', 'orange', 'green', 'pink'] as const;

/**
 * An icon is either a path to artwork or a character to letter the tile with.
 * A leading slash or scheme is the whole test — anything else stays a letter,
 * so tiles configured before this existed are untouched.
 */
const isArt = (icon: string | null): icon is string =>
  !!icon && (icon.startsWith('/') || icon.startsWith('http'));

/** A tile that opens a view here rather than navigating away. */
const isInternal = (url: string) => url.startsWith('#');

export const AppsView = ({ apps, onOpenView }: { apps: AppTile[]; onOpenView: (view: string) => void }) => {
  const checked = apps.filter((a) => a.healthy !== null);
  const passing = apps.filter((a) => a.healthy).length;

  return (
    <div class="page-stack">
      <div class="page-heading">
        <div>
          <p class="eyebrow">
            APPLICATIONS <span class="mini-led" />
          </p>
          <h1>Your service shelf.</h1>
          <p class="subhead">Everything worth opening, one click away.</p>
        </div>
        <div class="app-summary">
          <strong>
            {passing} / {checked.length || apps.length}
          </strong>
          <span>health checks passing</span>
        </div>
      </div>

      {apps.length === 0 && (
        <div class="app-note">
          <Gauge size={18} />
          <div>
            <strong>No apps configured yet</strong>
            <span>Add entries to dashboard/server/apps.json and they appear here.</span>
          </div>
        </div>
      )}

      <div class="apps-grid">
        {apps.map((app, i) => (
          <a
            class="app-tile"
            href={app.healthy ? app.url : undefined}
            target={isInternal(app.url) ? undefined : '_blank'}
            rel="noreferrer"
            onClick={(e) => {
              if (isInternal(app.url)) {
                e.preventDefault();
                onOpenView(app.url.slice(1));
              } else if (!app.healthy) {
                e.preventDefault();
              }
            }}
            key={app.name}
          >
            <div class={`app-icon ${isArt(app.icon) ? 'art' : ACCENTS[i % ACCENTS.length]}`}>
              {isArt(app.icon) ? (
                <img src={app.icon} alt="" loading="lazy" />
              ) : (
                <span>{app.icon ?? app.name[0]}</span>
              )}
            </div>
            <div class="app-info">
              <strong>{app.name}</strong>
              <span>{app.nodeId ?? 'fleet'}</span>
              <small>{isInternal(app.url) ? 'in this console' : new URL(app.url).port ? `:${new URL(app.url).port}` : ''}</small>
            </div>
            <div class="app-health">
              <StatusDot online={!!app.healthy} size="sm" />
              <span>{app.healthy === null ? 'not checked' : app.healthy ? 'healthy' : 'unreachable'}</span>
            </div>
            <Chevron size={16} class="app-arrow" />
          </a>
        ))}
      </div>

      {apps.length > 0 && (
        <div class="app-note">
          <Gauge size={18} />
          <div>
            <strong>Health checks run on every poll</strong>
            <span>A tile is reachable when its URL answers within two seconds.</span>
          </div>
        </div>
      )}
    </div>
  );
};
