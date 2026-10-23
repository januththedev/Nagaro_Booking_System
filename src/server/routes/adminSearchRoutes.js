/**
 * Admin global search routes. The HTML page is the primary surface; the JSON
 * endpoint exists for command-palette clients and is deliberately bounded.
 */
import { q } from '../http/request.js';
import { requireAdmin } from '../security/sessions.js';
import { searchAdmin } from '../services/adminSearchService.js';
import { renderSearchPage } from '../../web/views/admin/searchViews.js';

export function registerAdminSearchRoutes(router, deps = {}) {
  const db = deps.db;
  const guard = () => requireAdmin;

  router.get('/admin/search', async (ctx) => {
    const actor = guard()(ctx);
    const query = String(q(ctx.query, 'q') ?? '').trim();
    const result = searchAdmin(db, { query });
    ctx.html(renderSearchPage({
      actor,
      csrfToken: ctx.csrfToken,
      flash: ctx.flash,
      query: result.query,
      groups: result.groups,
      total: result.total,
    }));
  });

  router.get('/api/admin/search', async (ctx) => {
    guard()(ctx);
    const query = String(q(ctx.query, 'q') ?? '').trim();
    ctx.json({ ok: true, ...searchAdmin(db, { query }) });
  });
}
