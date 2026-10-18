import type { Config } from '../config.ts';
import type { Brain } from '../db.ts';

export interface ConnectorContext {
  brain: Brain;
  config: Config;
  log: (msg: string) => void;
  /** Override "now" in tests. */
  now?: Date;
}

export interface ConnectorResult {
  new: number;
  updated: number;
  /** Human-readable extras for the sync output, e.g. "38 files scanned". */
  notes?: string[];
}

export interface Connector {
  name: string;
  /** One line shown by `doctor` when the connector is disabled or misconfigured. */
  describe(cfg: Config): string;
  enabled(cfg: Config): boolean;
  run(ctx: ConnectorContext): Promise<ConnectorResult>;
}
