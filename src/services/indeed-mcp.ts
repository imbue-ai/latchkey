/**
 * Indeed MCP service: Indeed's remote MCP server for job seekers (job search,
 * job details, the user's resume, company data). Endpoints come from
 * https://mcp.indeed.com/.well-known/oauth-protected-resource/claude/mcp and
 * https://secure.indeed.com/.well-known/oauth-authorization-server.
 */

import { RemoteMcpService } from './core/remoteMcp.js';

export const INDEED_MCP = new RemoteMcpService({
  name: 'indeed-mcp',
  displayName: 'Indeed MCP',
  mcpEndpoint: 'https://mcp.indeed.com/claude/mcp',
  oauth: {
    authorizationEndpoint: 'https://secure.indeed.com/oauth/v2/authorize',
    tokenEndpoint: 'https://apis.indeed.com/oauth/v2/tokens',
    registrationEndpoint: 'https://secure.indeed.com/oauth/v2/register',
  },
  // The metadata also lists job_seeker.profile.read and
  // job_seeker.company.details.read, but client registration refuses them for
  // dynamically registered clients, so only the scopes it accepts are asked for.
  scopes: ['job_seeker.jobs.search', 'offline_access'],
  info:
    'https://docs.indeed.com/mcp (beta; tools: Job Search, Job Detail, Get Resume, Get Company Data). ' +
    'Indeed documents the server for the Claude connector only, so other clients may be refused; ' +
    'dynamically registered clients get only the job search scope, so the resume and company tools may be denied. ' +
    'Call `tools/list` for exact tool names and input schemas.',
});
