import { claudeSessions } from './claude-sessions.ts';
import { gitConnector } from './git.ts';
import { gmailConnector } from './gmail.ts';
import { notesConnector } from './notes.ts';
import type { Connector } from './types.ts';

export const CONNECTORS: Connector[] = [claudeSessions, gitConnector, notesConnector, gmailConnector];
export const SOURCES = CONNECTORS.map((c) => c.name);
