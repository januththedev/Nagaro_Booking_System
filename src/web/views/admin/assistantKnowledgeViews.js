import { attr, csrfField, dateTimeLabel, html } from '../../lib/html.js';
import { adminShell, card, pageContainer, table } from '../layout.js';
import { KNOWLEDGE_LIMITS } from '../../../server/services/assistantKnowledgeService.js';

export function renderAssistantKnowledgeListPage({
  actor, csrfToken, flash = null, entries = [],
}) {
  const rows = entries.map((entry) => ({
    cells: [
      html`<div><a href="/admin/guider-knowledge/${entry.id}/edit">${entry.title}</a>
        <div class="meta-line">${entry.slug}</div></div>`,
      html`<span class="badge ${entry.isActive ? 'badge--published' : 'badge--archived'}">
        ${entry.isActive ? 'Available to Guider' : 'Hidden'}
      </span>`,
      `${entry.markdown.length.toLocaleString('en')} characters`,
      dateTimeLabel(entry.updatedAt),
      html`<a class="button button--ghost button--small" href="/admin/guider-knowledge/${entry.id}/edit">Edit</a>`,
    ],
  }));

  const body = pageContainer({
    body: html`<div class="stack">
      ${card({
        title: 'Published knowledge for better answers',
        description: 'Add accurate public information about access, catering, policies, facilities and contacts. Guider searches only entries marked available.',
        body: html`<p class="hint">Markdown is stored as reference text and never rendered as executable HTML. Do not add private staff notes, credentials or customer information.</p>`,
      })}
      ${card({
        title: `${entries.length} knowledge ${entries.length === 1 ? 'entry' : 'entries'}`,
        actions: html`<a class="button button--primary button--small" href="/admin/guider-knowledge/new">Add knowledge</a>`,
        body: table({
          label: 'Guider knowledge entries',
          columns: [
            { label: 'Title' }, { label: 'Visibility' }, { label: 'Size' }, { label: 'Updated' }, { label: 'Actions' },
          ],
          rows,
          emptyMessage: 'No knowledge has been added yet. Add a Markdown entry to ground Guider in your public information.',
        }),
      })}
    </div>`,
  });

  return adminShell({
    title: 'Guider knowledge',
    subtitle: 'Curate the public information Guider can use when answering visitors.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/guider-knowledge',
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Guider knowledge' }],
    pageActions: html`<a class="button button--primary button--small" href="/admin/guider-knowledge/new">Add knowledge</a>`,
    body,
  });
}

export function renderAssistantKnowledgeFormPage({
  actor, csrfToken, flash = null, mode = 'create', entry = null, values = {}, error = null,
}) {
  const editing = mode === 'edit';
  const action = editing ? `/admin/guider-knowledge/${entry.id}` : '/admin/guider-knowledge';
  const title = editing ? `Edit ${entry.title}` : 'Add Guider knowledge';
  const current = {
    title: values.title ?? entry?.title ?? '',
    slug: values.slug ?? entry?.slug ?? '',
    markdown: values.markdown ?? entry?.markdown ?? '',
    is_active: values.is_active ?? (entry?.isActive === false ? '' : '1'),
  };

  const form = html`<form method="post" action="${action}" enctype="multipart/form-data" class="form-grid form-card" data-submit-once>
    ${csrfField(csrfToken)}
    ${error ? html`<div class="alert alert--error form-field--full" role="alert"><p>${error}</p></div>` : ''}
    <div class="form-field">
      <label for="knowledge-title">Title</label>
      <input id="knowledge-title" name="title" value="${current.title}" maxlength="${KNOWLEDGE_LIMITS.title}" required autocomplete="off">
      <p class="hint">A clear internal label, such as “Visitor access and parking”.</p>
    </div>
    <div class="form-field">
      <label for="knowledge-slug">Slug</label>
      <input id="knowledge-slug" name="slug" value="${current.slug}" maxlength="${KNOWLEDGE_LIMITS.slug}" placeholder="visitor-access-parking" autocomplete="off">
      <p class="hint">Optional. A stable identifier is generated from the title if left blank.</p>
    </div>
    <div class="form-field form-field--full">
      <label for="knowledge-markdown">Markdown information</label>
      <textarea id="knowledge-markdown" name="markdown" rows="18" maxlength="${KNOWLEDGE_LIMITS.markdown}"
        aria-describedby="knowledge-markdown-hint">${current.markdown}</textarea>
      <p class="hint" id="knowledge-markdown-hint">Paste Markdown here, or choose a .md file below. An uploaded file replaces the pasted text for this save. Maximum 100,000 characters.</p>
    </div>
    <div class="form-field form-field--full">
      <label for="knowledge-file">Upload a Markdown file <span class="hint">(optional)</span></label>
      <input id="knowledge-file" name="knowledge_file" type="file" accept=".md,.markdown,text/markdown,text/plain">
    </div>
    <label class="check-row form-field--full" for="knowledge-active">
      <input id="knowledge-active" name="is_active" type="checkbox" value="1"${attr('checked', current.is_active === '1' || current.is_active === true)}>
      <span><strong>Available to Guider</strong><span class="hint">Only enable content that is accurate and safe to share publicly.</span></span>
    </label>
    <div class="cluster form-field--full">
      <button class="button button--primary" type="submit">${editing ? 'Save changes' : 'Add knowledge'}</button>
      <a class="button button--ghost" href="/admin/guider-knowledge">Cancel</a>
    </div>
  </form>`;

  const body = pageContainer({
    body: html`<div class="stack">
      ${card({
        title: editing ? 'Knowledge entry' : 'New public reference',
        description: 'Guider uses this information only when it matches a visitor’s question.',
        body: form,
      })}
      ${editing ? card({
        title: 'Delete entry',
        description: 'This permanently removes the entry. Hide it instead if you may need it again.',
        body: html`<form method="post" action="/admin/guider-knowledge/${entry.id}/delete" data-submit-once>
          ${csrfField(csrfToken)}
          <button class="button button--danger" type="submit">Delete knowledge entry</button>
        </form>`,
      }) : ''}
    </div>`,
  });

  return adminShell({
    title,
    subtitle: 'Markdown remains plain reference content; it is not rendered as HTML on the public site.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/guider-knowledge',
    breadcrumbs: [
      { label: 'Admin', href: '/admin' },
      { label: 'Guider knowledge', href: '/admin/guider-knowledge' },
      { label: editing ? 'Edit' : 'Add' },
    ],
    body,
  });
}
