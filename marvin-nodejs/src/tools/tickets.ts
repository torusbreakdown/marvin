/**
 * Ticket System Tools
 * tk, create_ticket, ticket_add_dep, ticket_start, ticket_close, etc.
 */

import { z } from 'zod';
import { defineTool, toolRegistry } from './base.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { generateId } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

// Ticket storage path
const TICKETS_DIR = join(process.cwd(), '.tickets');

interface Ticket {
  id: string;
  title: string;
  description?: string;
  type: 'bug' | 'feature' | 'task' | 'epic' | 'chore';
  status: 'open' | 'in_progress' | 'closed';
  priority: number;
  tags: string[];
  parent?: string;
  dependencies: string[];
  notes: string[];
  created: string;
  updated: string;
}

function ensureTicketsDir(): void {
  if (!existsSync(TICKETS_DIR)) {
    mkdirSync(TICKETS_DIR, { recursive: true });
  }
}

function loadTicket(id: string): Ticket | null {
  const path = join(TICKETS_DIR, `${id}.md`);
  if (!existsSync(path)) return null;
  
  const content = readFileSync(path, 'utf-8');
  // Parse markdown frontmatter
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  
  const data: Record<string, unknown> = {};
  const lines = frontmatter[1].split('\n');
  for (const line of lines) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      data[key.trim()] = rest.join(':').trim();
    }
  }
  
  return {
    id: data.id as string,
    title: data.title as string,
    description: data.description as string,
    type: data.type as Ticket['type'],
    status: data.status as Ticket['status'],
    priority: parseInt(data.priority as string, 10),
    tags: (data.tags as string)?.split(',').map(t => t.trim()) || [],
    parent: data.parent as string,
    dependencies: (data.dependencies as string)?.split(',').map(d => d.trim()) || [],
    notes: [],
    created: data.created as string,
    updated: data.updated as string,
  };
}

function saveTicket(ticket: Ticket): void {
  ensureTicketsDir();
  const path = join(TICKETS_DIR, `${ticket.id}.md`);
  
  const lines = [
    '---',
    `id: ${ticket.id}`,
    `title: ${ticket.title}`,
    `type: ${ticket.type}`,
    `status: ${ticket.status}`,
    `priority: ${ticket.priority}`,
    `tags: ${ticket.tags.join(', ')}`,
    `created: ${ticket.created}`,
    `updated: ${ticket.updated}`,
  ];
  
  if (ticket.parent) lines.push(`parent: ${ticket.parent}`);
  if (ticket.dependencies.length) lines.push(`dependencies: ${ticket.dependencies.join(', ')}`);
  if (ticket.description) lines.push(`description: ${ticket.description}`);
  
  lines.push('---', '');
  
  if (ticket.notes.length) {
    lines.push('## Notes', '');
    for (const note of ticket.notes) {
      lines.push(`- ${note}`);
    }
  }
  
  writeFileSync(path, lines.join('\n'), 'utf-8');
}

// First-ticket rejection tracking
let firstTicketAttempted = false;
let firstTicketRejected = false;

export const tkTool = defineTool({
  name: 'tk',
  description: "Run the tk ticket CLI. Use to create epics for pipeline stages, tasks for individual agent work items, track status, and add notes. Tickets are stored as markdown in .tickets/. Supports: create, start, close, show, ls, dep, add-note, blocked, dep-tree",
  parameters: z.object({
    args: z.string().describe("Arguments to pass to the tk CLI. Examples:\n'create \"Phase 1a: Spec\" -t epic --parent PARENT_ID'\n'create \"Write product spec\" -t task --parent EPIC_ID'\n'start TICKET_ID'\n'close TICKET_ID'\n'add-note TICKET_ID \"some note\"'\n'show TICKET_ID'\n'ls --status=open'"),
  }),
  readonly: false,
  
  async execute({ args }) {
    ensureTicketsDir();
    
    const parts = args.split(' ');
    const command = parts[0];
    
    // First rejection logic
    if (command === 'create' && !firstTicketAttempted) {
      firstTicketAttempted = true;
      firstTicketRejected = true;
      return `ERROR: First ticket creation is intentionally rejected to encourage thorough descriptions.\n\nPlease retry with a DETAILED description including:\n- What exactly will be done\n- Acceptance criteria (bullet list)\n- Key files to create or modify\n- Dependencies on other work\n\nExample: tk create "Implement user auth" -t task -d "Complete user authentication system\n\n## Deliverables\n- Login endpoint\n- JWT token handling\n- Password hashing\n\n## Acceptance Criteria\n- [ ] Users can register\n- [ ] Users can login\n- [ ] Tokens expire after 24h"`;
    }
    
    if (command === 'create') {
      // Parse create args
      const titleMatch = args.match(/"([^"]+)"/);
      const title = titleMatch?.[1] || 'Untitled';
      
      const typeMatch = args.match(/-t\s+(\w+)/);
      const type = (typeMatch?.[1] as Ticket['type']) || 'task';
      
      const parentMatch = args.match(/--parent\s+(\S+)/);
      const parent = parentMatch?.[1];
      
      const priorityMatch = args.match(/-p\s+(\d)/);
      const priority = priorityMatch ? parseInt(priorityMatch[1], 10) : 2;
      
      const id = generateId(6);
      const now = new Date().toISOString();
      
      const ticket: Ticket = {
        id,
        title,
        type,
        status: 'open',
        priority,
        tags: [],
        parent,
        dependencies: [],
        notes: [],
        created: now,
        updated: now,
      };
      
      saveTicket(ticket);
      logger.info(`Created ticket: ${id} - ${title}`);
      
      // Mark ticket as created for gating
      const parentTicketId = toolRegistry.getContext().ticketId;
      if (parentTicketId) {
        toolRegistry.markTicketCreated(id);
      }
      
      return `Created ticket: ${id}\nTitle: ${title}\nType: ${type}\nStatus: open`;
    }
    
    if (command === 'start') {
      const id = parts[1];
      const ticket = loadTicket(id);
      if (!ticket) return `Ticket not found: ${id}`;
      
      ticket.status = 'in_progress';
      ticket.updated = new Date().toISOString();
      saveTicket(ticket);
      
      return `Started ticket: ${id}`;
    }
    
    if (command === 'close') {
      const id = parts[1];
      const ticket = loadTicket(id);
      if (!ticket) return `Ticket not found: ${id}`;
      
      ticket.status = 'closed';
      ticket.updated = new Date().toISOString();
      saveTicket(ticket);
      
      return `Closed ticket: ${id}`;
    }
    
    if (command === 'show') {
      const id = parts[1];
      const ticket = loadTicket(id);
      if (!ticket) return `Ticket not found: ${id}`;
      
      const lines = [
        `Ticket: ${ticket.id}`,
        `Title: ${ticket.title}`,
        `Type: ${ticket.type}`,
        `Status: ${ticket.status}`,
        `Priority: ${ticket.priority}`,
      ];
      
      if (ticket.parent) lines.push(`Parent: ${ticket.parent}`);
      if (ticket.dependencies.length) lines.push(`Dependencies: ${ticket.dependencies.join(', ')}`);
      if (ticket.tags.length) lines.push(`Tags: ${ticket.tags.join(', ')}`);
      
      return lines.join('\n');
    }
    
    if (command === 'ls') {
      const files = readdirSync(TICKETS_DIR).filter(f => f.endsWith('.md'));
      
      if (files.length === 0) {
        return 'No tickets found.';
      }
      
      const lines = ['Tickets:'];
      
      for (const file of files) {
        const id = file.replace('.md', '');
        const ticket = loadTicket(id);
        if (ticket) {
          lines.push(`${id}: [${ticket.status}] ${ticket.title}`);
        }
      }
      
      return lines.join('\n');
    }
    
    return `Unknown tk command: ${command}`;
  },
});

export const createTicketTool = defineTool({
  name: 'create_ticket',
  description: "Create a TODO / ticket using the local 'tk' ticket system. Use this whenever the user wants to note a task, track a bug, plan a feature, or create any kind of to-do item. Returns the new ticket ID.",
  parameters: z.object({
    title: z.string().describe("Short title for the ticket, e.g. 'Fix login timeout bug'"),
    description: z.string().optional().describe('Longer description of the task or issue.'),
    ticket_type: z.string().default('task').describe("Type: 'bug', 'feature', 'task', 'epic', or 'chore'."),
    priority: z.number().default(2).describe('Priority 0-4 where 0 is highest. Default is 2 (medium).'),
    tags: z.string().optional().describe("Comma-separated tags, e.g. 'ui,backend,urgent'."),
    parent: z.string().optional().describe('Parent ticket ID if this is a sub-task.'),
  }),
  readonly: false,
  
  async execute(params) {
    const args = [`create "${params.title}"`, `-t ${params.ticket_type}`];
    if (params.parent) args.push(`--parent ${params.parent}`);
    
    return tkTool.execute!({ args: args.join(' ') });
  },
});
