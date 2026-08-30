import { Activity, AlertTriangle, ChevronRight, Power, Router, Thermometer } from 'lucide-react';
import type { FleetNode } from '../../../shared/fleet';
import { capacity, celsius, cpuTone, memTone, pct, relative, uptime, watts } from '../lib/format';
import { Meter, Readout, StatusDot } from './primitives';

const NodeCard = ({ node, onOpen }: { node: FleetNode; onOpen: (id: string) => void }) => {
  // Three states, not two: a board that is off reads differently from one whose
  // agents have stopped answering.
  const unreachable = node.online && !!node.error;

  if (!node.online || unreachable) {
    return (
      <div className={`node-card offline-card ${unreachable ? 'agent-down' : ''}`}>
        <div className="node-card-head">
          <div className="node-identity">
            <StatusDot online={false} />
            <span className="node-name">{node.name}</span>
            <span className="node-address">{node.tailscaleIp}</span>
          </div>
        </div>
        <div className="node-role">
          {unreachable ? `${node.role} · agent not responding` : `offline · ${relative(node.lastSeen)}`}
        </div>
        <div className="offline-copy">
          <span>{unreachable ? 'Node is up but reporting nothing' : 'Waiting for node to return'}</span>
          <ChevronRight size={16} />
        </div>
      </div>
    );
  }

  const cpu = node.cpu?.usagePct ?? 0;
  const mem = node.mem?.usedPct ?? 0;
  const throttled = node.temp?.throttled;
  const throttleNow = throttled?.now ?? false;
  const throttledEver = throttled?.everSinceBoot ?? false;

  return (
    <button className="node-card" onClick={() => onOpen(node.id)}>
      <div className="node-card-head">
        <div className="node-identity">
          <StatusDot online />
          <span className="node-name">{node.name}</span>
          <span className="node-address">{node.tailscaleIp}</span>
        </div>
        <span className="ram-capacity">{capacity(node.mem?.totalBytes)}</span>
      </div>
      <div className="node-role">{node.role}</div>

      <div className="meter-row">
        <span>CPU</span>
        <Meter value={cpu} tone={cpuTone(cpu)} />
        <strong>{pct(cpu)}</strong>
      </div>
      <div className="meter-row">
        <span>RAM</span>
        <Meter value={mem} tone={memTone(mem)} />
        <strong>{pct(mem)}</strong>
      </div>

      <div className="node-card-meta">
        <span>
          <Thermometer size={14} /> {celsius(node.temp?.cpuC)}
        </span>
        {/* Power is Pi 5 only — a node without the capability shows nothing here
            rather than an empty tile. */}
        {node.capabilities.includes('power') && (
          <span>
            <Power size={14} /> {watts(node.power?.watts)}
          </span>
        )}
        <span>
          <Activity size={14} /> up {uptime(node.uptimeSec)}
        </span>
      </div>

      <div className="node-card-footer">
        <span>
          {throttleNow ? (
            <>
              <AlertTriangle size={13} /> throttling now
            </>
          ) : throttledEver ? (
            <>
              <AlertTriangle size={13} /> throttled since boot
            </>
          ) : (
            <>
              <span className="check-mark">✓</span> no throttling
            </>
          )}
        </span>
        <span className="inspect">
          inspect <ChevronRight size={14} />
        </span>
      </div>
    </button>
  );
};

export const FleetView = ({ nodes, onOpen }: { nodes: FleetNode[]; onOpen: (id: string) => void }) => {
  const live = nodes.filter((n) => n.online && !n.error);
  const throttling = live.filter((n) => n.temp?.throttled?.now).length;

  const avgCpu = live.length
    ? live.reduce((sum, n) => sum + (n.cpu?.usagePct ?? 0), 0) / live.length
    : 0;

  const warmest = live.reduce<FleetNode | null>(
    (hot, n) => ((n.temp?.cpuC ?? -1) > (hot?.temp?.cpuC ?? -1) ? n : hot),
    null,
  );

  const powered = live.filter((n) => n.power);
  const totalWatts = powered.reduce((sum, n) => sum + (n.power?.watts ?? 0), 0);

  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            FLEET OVERVIEW <span className="mini-led" />
          </p>
          <h1>Good morning, operator.</h1>
          <p className="subhead">A quiet watch over your little corner of the internet.</p>
        </div>
        <div className="heading-stats">
          <div>
            <strong>
              {live.length}/{nodes.length}
            </strong>
            <span>nodes online</span>
          </div>
          <div>
            <strong>{throttling}</strong>
            <span>throttling</span>
          </div>
        </div>
      </div>

      <div className="discovery-banner">
        <div className="discovery-icon">
          <Router size={19} />
        </div>
        <div>
          <strong>Auto-discovery is active</strong>
          <span>New Tailnet devices will appear here automatically.</span>
        </div>
        <span className="discovery-count">
          SCANNING <i />
        </span>
      </div>

      <div className="node-grid">
        {nodes.map((node) => (
          <NodeCard key={node.id} node={node} onOpen={onOpen} />
        ))}
      </div>

      <div className="section-rule">
        <span>QUICK READOUT</span>
        <div />
      </div>
      <div className="readout-grid">
        <Readout
          icon={<Activity />}
          label="Fleet CPU"
          value={pct(avgCpu)}
          detail={avgCpu > 80 ? 'saturated' : avgCpu > 50 ? 'busy' : 'nominal'}
          tone={avgCpu > 80 ? 'orange' : 'green'}
        />
        <Readout
          icon={<Thermometer />}
          label="Warmest node"
          value={celsius(warmest?.temp?.cpuC)}
          detail={warmest ? `${warmest.name} · ${(warmest.temp?.cpuC ?? 0) > 70 ? 'hot' : 'normal'}` : '—'}
          tone={(warmest?.temp?.cpuC ?? 0) > 70 ? 'orange' : 'aqua'}
        />
        <Readout
          icon={<Power />}
          label="Power draw"
          value={powered.length ? watts(totalWatts) : '—'}
          detail={powered.length ? `across ${powered.length} node${powered.length > 1 ? 's' : ''}` : 'no PMIC nodes'}
          tone="aqua"
        />
      </div>
    </div>
  );
};
