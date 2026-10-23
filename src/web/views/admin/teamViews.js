/**
 * Team & access screen: two-role administration, the three-seat Super Admin
 * cap and the 30-day recycle bin.
 */
import { attr, csrfField, dateTimeLabel, html } from '../../lib/html.js';
import { adminShell, card, pageContainer } from '../layout.js';
import {
  ADMIN_ROLE, MAX_SUPER_ADMINS, RECYCLE_BIN_RETENTION_DAYS,
} from '../../../server/domain/constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function roleBadge(role) {
  const superAdmin = role === ADMIN_ROLE.SUPER_ADMIN;
  return html`<span class="team-role ${superAdmin ? 'team-role--super' : 'team-role--admin'}">
    ${superAdmin ? 'Super Admin' : 'Admin'}
  </span>`;
}

function statusBadge(member) {
  if (member.isDeleted) return html`<span class="team-status team-status--deleted">In recycle bin</span>`;
  if (!member.isActive) return html`<span class="team-status team-status--disabled">Disabled</span>`;
  if (member.mustChangePassword) return html`<span class="team-status team-status--pending">Password change required</span>`;
  return html`<span class="team-status team-status--active">Active</span>`;
}

function lastSignIn(member) {
  return member.lastLoginAt ? dateTimeLabel(member.lastLoginAt) : 'Never';
}

function capMeter(superCount) {
  const full = superCount >= MAX_SUPER_ADMINS;
  return html`<section class="card team-cap ${full ? 'team-cap--full' : ''}" aria-labelledby="team-cap-title">
    <div class="team-cap__copy">
      <p class="section-eyebrow">Access ceiling</p>
      <h2 class="card__title" id="team-cap-title">${superCount} of ${MAX_SUPER_ADMINS} Super Admin seats in use</h2>
      <p class="card__description">
        ${full
          ? 'The cap is reached. Demote or delete a Super Admin before promoting another.'
          : `There ${MAX_SUPER_ADMINS - superCount === 1 ? 'is' : 'are'} ${MAX_SUPER_ADMINS - superCount} available Super Admin ${MAX_SUPER_ADMINS - superCount === 1 ? 'seat' : 'seats'}. Super Admins can manage team access; Admins can run the console and manage their own password.`}
      </p>
    </div>
    <div class="team-cap__meter" role="img" aria-label="${superCount} of ${MAX_SUPER_ADMINS} Super Admin seats in use">
      <span class="team-cap__fill team-cap__fill--${Math.min(MAX_SUPER_ADMINS, Math.max(0, Number(superCount) || 0))}"></span>
    </div>
  </section>`;
}

function revealedPassword(revealed) {
  if (!revealed) return '';
  return html`<section class="card team-credential" role="status" aria-live="polite">
    <div class="card__body">
      <p class="section-eyebrow">One-time credential</p>
      <h2 class="card__title">${revealed.title}</h2>
      <p>${revealed.note}</p>
      <dl class="detail-list team-credential__details">
        <dt>Account</dt><dd>${revealed.email}</dd>
        <dt>Temporary password</dt>
        <dd>
          <span class="team-credential__password">
            <code id="team-temp-password">${revealed.password}</code>
            <button class="button button--ghost button--small" type="button"
                    data-copy-target="#team-temp-password">Copy password</button>
          </span>
        </dd>
      </dl>
      <p class="hint">Share it through a secure channel. It will not be shown again, and the account must choose a new password after signing in.</p>
    </div>
  </section>`;
}

function memberActions(member, { actor, csrfToken, superCount }) {
  const isSelf = Number(member.id) === Number(actor?.id);
  const lastActiveSuper = member.isSuperAdmin && member.isActive && superCount <= 1;
  const atCap = superCount >= MAX_SUPER_ADMINS;
  const nextRole = member.isSuperAdmin ? ADMIN_ROLE.ADMIN : ADMIN_ROLE.SUPER_ADMIN;
  const roleActionBlocked = member.isSuperAdmin ? lastActiveSuper : atCap;

  return html`<div class="team-member__actions">
    <form method="post" action="/admin/team/${member.id}/role" class="inline-form" data-submit-once>
      ${csrfField(csrfToken)}
      <input type="hidden" name="role" value="${nextRole}">
      <button class="button button--ghost button--small" type="submit"
              ${attr('disabled', roleActionBlocked)}
              title="${roleActionBlocked
                ? (member.isSuperAdmin
                  ? 'At least one active Super Admin must remain.'
                  : `All ${MAX_SUPER_ADMINS} Super Admin seats are in use.`)
                : ''}">
        ${member.isSuperAdmin ? 'Make Admin' : 'Make Super Admin'}
      </button>
    </form>

    <form method="post" action="/admin/team/${member.id}/reset" class="inline-form" data-submit-once>
      ${csrfField(csrfToken)}
      <button class="button button--ghost button--small" type="submit">Reset password</button>
    </form>

    <form method="post" action="/admin/team/${member.id}/delete" class="inline-form"
          data-confirm="Move ${member.email} to the recycle bin? They will lose access immediately and the account is permanently purged after ${RECYCLE_BIN_RETENTION_DAYS} days."
          data-submit-once>
      ${csrfField(csrfToken)}
      <button class="button button--danger button--small" type="submit"
              ${attr('disabled', isSelf || lastActiveSuper)}
              title="${isSelf
                ? 'You cannot delete your own account.'
                : lastActiveSuper ? 'At least one active Super Admin must remain.' : ''}">
        Delete
      </button>
    </form>
  </div>`;
}

function memberCard(member, context) {
  const lastActiveSuper = member.isSuperAdmin && member.isActive && context.superCount <= 1;
  const atCap = context.superCount >= MAX_SUPER_ADMINS;
  return html`<article class="team-member ${member.isSuperAdmin ? 'team-member--super' : ''}"
                       data-member-id="${member.id}">
    <header class="team-member__head">
      <span class="team-avatar" aria-hidden="true">${initials(member.displayName)}</span>
      <div class="team-member__identity">
        <h3 class="team-member__name">${member.displayName}${Number(member.id) === Number(context.actor?.id)
          ? html`<span class="team-you">You</span>` : ''}</h3>
        <p class="team-member__email">${member.email}</p>
        <div class="team-member__badges">${roleBadge(member.role)}${statusBadge(member)}</div>
      </div>
    </header>
    <dl class="team-member__meta">
      <div><dt>Last sign-in</dt><dd>${lastSignIn(member)}</dd></div>
      <div><dt>Added</dt><dd>${dateTimeLabel(member.createdAt)}</dd></div>
      <div><dt>Access</dt><dd>${member.isSuperAdmin ? 'Full team control' : 'Console access'}</dd></div>
    </dl>
    ${member.isActive ? memberActions(member, context) : html`<p class="hint">This account is disabled and cannot sign in.</p>`}
    <details class="team-member__edit">
      <summary>Edit name, email or role</summary>
      <form method="post" action="/admin/team/${member.id}" class="form-grid" data-submit-once>
        ${csrfField(context.csrfToken)}
        <div class="form-field">
          <label for="member-name-${member.id}">Name</label>
          <input id="member-name-${member.id}" name="display_name" value="${member.displayName}" maxlength="160" required>
        </div>
        <div class="form-field">
          <label for="member-email-${member.id}">Email</label>
          <input id="member-email-${member.id}" name="email" type="email" value="${member.email}" maxlength="254" required>
        </div>
        <div class="form-field">
          <label for="member-role-${member.id}">Role</label>
          <select id="member-role-${member.id}" name="role">
            <option value="${ADMIN_ROLE.ADMIN}"${attr('selected', member.role === ADMIN_ROLE.ADMIN)}>Admin</option>
            <option value="${ADMIN_ROLE.SUPER_ADMIN}"
              ${attr('disabled', member.role !== ADMIN_ROLE.SUPER_ADMIN && atCap)}
              ${attr('selected', member.role === ADMIN_ROLE.SUPER_ADMIN)}>Super Admin</option>
          </select>
          ${member.isSuperAdmin && lastActiveSuper
            ? html`<p class="hint">The last active Super Admin cannot be demoted.</p>` : ''}
        </div>
        <div class="form-actions form-field--full">
          <button class="button button--primary button--small" type="submit">Save details</button>
        </div>
      </form>
    </details>
  </article>`;
}

function deletedCard(member, { actor, csrfToken, superCount, now }) {
  const purgeAfter = Number(member.purgeAfter ?? 0);
  const daysLeft = purgeAfter ? Math.max(0, Math.ceil((purgeAfter - now) / DAY_MS)) : 0;
  const atCap = superCount >= MAX_SUPER_ADMINS;
  return html`<article class="team-member team-member--deleted" data-member-id="${member.id}">
    <header class="team-member__head">
      <span class="team-avatar" aria-hidden="true">${initials(member.displayName)}</span>
      <div class="team-member__identity">
        <h3 class="team-member__name">${member.displayName}</h3>
        <p class="team-member__email">${member.email}</p>
        <div class="team-member__badges">${roleBadge(member.role)}${statusBadge(member)}</div>
      </div>
    </header>
    <dl class="team-member__meta">
      <div><dt>Deleted</dt><dd>${member.deletedAt ? dateTimeLabel(member.deletedAt) : '—'}</dd></div>
      <div><dt>Auto-purge</dt><dd>${purgeAfter ? dateTimeLabel(purgeAfter) : '—'}</dd></div>
      <div><dt>Time left</dt><dd>${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}</dd></div>
    </dl>
    <p class="hint">The email address stays reserved until the account is purged. Restoring a Super Admin requires a free seat.</p>
    <div class="team-member__actions">
      <form method="post" action="/admin/team/${member.id}/restore" class="inline-form" data-submit-once>
        ${csrfField(csrfToken)}
        <button class="button button--primary button--small" type="submit"
                ${attr('disabled', member.isSuperAdmin && atCap)}
                title="${member.isSuperAdmin && atCap ? `All ${MAX_SUPER_ADMINS} Super Admin seats are in use.` : ''}">
          Restore account
        </button>
      </form>
      <form method="post" action="/admin/team/${member.id}/purge" class="inline-form"
            data-confirm="Permanently delete ${member.email} now? The email becomes available again and this cannot be undone."
            data-submit-once>
        ${csrfField(csrfToken)}
        <button class="button button--danger button--small" type="submit">Delete permanently</button>
      </form>
    </div>
  </article>`;
}

function addAdminForm({ csrfToken, superCount }) {
  const atCap = superCount >= MAX_SUPER_ADMINS;
  return html`<details class="card team-add">
    <summary class="team-add__summary">
      <span>
        <span class="section-eyebrow">New account</span>
        <span class="card__title">Add an administrator</span>
      </span>
      <span class="team-add__plus" aria-hidden="true">+</span>
    </summary>
    <form method="post" action="/admin/team" class="form-grid team-add__form" data-submit-once>
      ${csrfField(csrfToken)}
      <div class="form-field">
        <label for="team-name">Full name</label>
        <input id="team-name" name="display_name" maxlength="160" required autocomplete="name" placeholder="Operations lead">
      </div>
      <div class="form-field">
        <label for="team-email">Email address</label>
        <input id="team-email" name="email" type="email" maxlength="254" required autocomplete="off" placeholder="name@trace.lk">
      </div>
      <div class="form-field">
        <label for="team-role">Role</label>
        <select id="team-role" name="role">
          <option value="${ADMIN_ROLE.ADMIN}">Admin — console access</option>
          <option value="${ADMIN_ROLE.SUPER_ADMIN}" ${attr('disabled', atCap)}>
            Super Admin — full team control${atCap ? ' (cap reached)' : ''}
          </option>
        </select>
        <p class="hint">${atCap
          ? `All ${MAX_SUPER_ADMINS} Super Admin seats are currently in use.`
          : 'Super Admins can add, reset, promote and delete accounts.'}</p>
      </div>
      <div class="form-field">
        <label for="team-password">Initial password <span class="hint">(optional)</span></label>
        <input id="team-password" name="password" type="password" minlength="10" autocomplete="new-password"
               aria-describedby="team-password-hint" placeholder="At least 10 characters">
        <p class="hint" id="team-password-hint">Leave blank to generate a secure temporary password. Generated passwords must be changed at first sign-in.</p>
        <label class="check-row" for="team-generate">
          <input id="team-generate" name="generate" type="checkbox" value="1">
          <span>Generate a secure temporary password</span>
        </label>
      </div>
      <div class="form-actions form-field--full">
        <button class="button button--primary" type="submit">Create account</button>
      </div>
    </form>
  </details>`;
}

export function renderTeamPage({
  actor, csrfToken, flash = null, members = [], deletedMembers = [],
  superCount = 0, tab = 'active', revealed = null, now = Date.now(),
}) {
  const activeMembers = members.filter((member) => !member.isDeleted);
  const context = { actor, csrfToken, superCount };

  const tabs = html`<nav class="team-tabs" aria-label="Team account views">
    <a href="/admin/team" class="team-tabs__link ${tab === 'active' ? 'is-active' : ''}"
       ${tab === 'active' ? html`aria-current="page"` : ''}>
      Active accounts <span class="team-tabs__count">${activeMembers.length}</span>
    </a>
    <a href="/admin/team?tab=recycle" class="team-tabs__link ${tab === 'recycle' ? 'is-active' : ''}"
       ${tab === 'recycle' ? html`aria-current="page"` : ''}>
      Recycle bin <span class="team-tabs__count">${deletedMembers.length}</span>
    </a>
  </nav>`;

  const activePanel = html`<div class="stack">
    ${capMeter(superCount)}
    ${addAdminForm({ csrfToken, superCount })}
    <section class="team-list" aria-label="Active administrator accounts">
      ${activeMembers.length
        ? activeMembers.map((member) => memberCard(member, context))
        : html`<p class="empty-state__message">No administrator accounts yet.</p>`}
    </section>
  </div>`;

  const recyclePanel = html`<div class="stack">
    ${card({
      title: 'Recycle bin',
      description: `Deleted accounts keep their email reserved and can be restored for ${RECYCLE_BIN_RETENTION_DAYS} days. After that they are purged automatically; a purged account cannot be restored.`,
      body: html`<p class="hint">Deleting an account signs the person out immediately. Recycle-bin accounts cannot sign in and do not occupy a Super Admin seat.</p>`,
    })}
    <section class="team-list" aria-label="Recycle bin">
      ${deletedMembers.length
        ? deletedMembers.map((member) => deletedCard(member, { ...context, now }))
        : html`<div class="empty-state"><p class="empty-state__message">The recycle bin is empty.</p><p class="empty-state__hint">Deleted accounts appear here for ${RECYCLE_BIN_RETENTION_DAYS} days.</p></div>`}
    </section>
  </div>`;

  const body = pageContainer({
    body: html`<div class="stack">
      ${revealedPassword(revealed)}
      ${tabs}
      ${tab === 'recycle' ? recyclePanel : activePanel}
    </div>`,
  });

  return adminShell({
    title: 'Team & access',
    subtitle: 'Two roles, three Super Admin seats and a 30-day safety net for deleted accounts.',
    actor,
    csrfToken,
    flash,
    activePath: '/admin/team',
    extraStyles: ['/assets/admin-team.css'],
    extraScripts: ['/assets/admin-team.js'],
    breadcrumbs: [{ label: 'Admin', href: '/admin' }, { label: 'Team & access' }],
    body,
  });
}
