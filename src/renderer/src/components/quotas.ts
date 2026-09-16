/**
 * Per-model quota detail, for a provider that publishes one figure per model.
 *
 * THE RULE THIS COMPONENT EXISTS TO ENFORCE
 * -----------------------------------------
 * The figure lives on the GROUP. Member rows carry NAMES ONLY. There is no
 * code path here that renders a model name next to a percentage, and that is
 * the whole point: an Antigravity row lists "Claude Opus 4.6" among its
 * models, and it sits directly beneath the user's real Claude Code row showing
 * a different number. "Claude Opus 4.6 · %60" would read as a statement about
 * their Claude subscription in every screenshot, every crop and every screen
 * reader pass.
 *
 * The contract already makes that string unconstructible — `ModelQuotaGroup`
 * has a figure, a reset and a member-name list, and nothing that pairs one
 * name with one number (contract.ts). This file must not reintroduce it by
 * zipping the two together for display. Groups are what carry numbers.
 *
 * Nothing is lost by it. Groups are formed by de-duplicating identical
 * (figure, reset) pairs, so every member of a group has exactly the group's
 * figure; splitting it per name would print the same number N times and add
 * only the ambiguity.
 *
 * WHY IT IS ALWAYS OFFERED, NOT ONLY WHEN THE FIGURES DIVERGE
 * ----------------------------------------------------------
 * An earlier design gated the whole disclosure on `diverged`, on the grounds
 * that one figure repeated eight times is not worth a control. The user has
 * since asked for this breakdown by name, and a control that appears only on
 * the days the data happens to be interesting is a control they cannot learn.
 * So it is always there and always collapsed, and the summary line says which
 * of the two situations they are in before they open it.
 *
 * WHY THE COLLAPSED LINE IS QUIET
 * -------------------------------
 * This is a hover panel. The collapsed state reports a count, not a reading:
 * the number that matters is already on the meter above, and a second loud
 * figure here would compete with it. Only the expanded state carries
 * percentages.
 */

import type { ModelQuotaDetail, ModelQuotaGroup } from '../../../shared/contract.js';
import { el, on, replaceChildrenWith, setAttr, setText } from '../dom.js';
import { asOf, clockTimeWithDay, parseInstant, percent, stateFor } from '../format.js';
import { t } from '../i18n.js';

export interface QuotaHandle {
  el: HTMLElement;
  /** `degraded` is the row's effective status being 'stale' or 'error'. */
  update(detail: ModelQuotaDetail | null, providerName: string, degraded?: boolean): void;
}

/** Total members across every group — what the collapsed line counts. */
function memberCount(groups: readonly ModelQuotaGroup[]): number {
  let total = 0;
  for (const group of groups) total += group.members.length;
  return total;
}

/**
 * The collapsed summary.
 *
 * A count and, when it is true, the fact that the figures differ. No
 * percentage: the meter above already owns the row's reading, and repeating a
 * figure here would make the user compare two numbers that are the same claim.
 */
function summaryText(detail: ModelQuotaDetail): string {
  const models = memberCount(detail.groups);
  const base = t('quota.summary', { count: models });
  return detail.diverged
    ? t('quota.summaryDiverged', { base, count: detail.groups.length })
    : base;
}

function spokenSummary(detail: ModelQuotaDetail, providerName: string): string {
  const models = memberCount(detail.groups);
  const shape = detail.diverged
    ? t('quota.shapeDiverged', { count: detail.groups.length })
    : t('quota.shapeSame');
  return t('quota.spoken', { provider: providerName, count: models, shape });
}

/**
 * One group: its figure, how many models share it, and when it resets.
 *
 * The reset is printed as an instant rather than a countdown. The countdown
 * belongs to the window block above, which owns the 1Hz tick; a second live
 * duration here would be a second thing to keep in sync for no added truth,
 * and `clockTimeWithDay` stays correct for a reset that is days out.
 */
function groupHeadText(group: ModelQuotaGroup): string {
  const parts = [t('quota.used', { percent: percent(group.usedPercentage) })];
  parts.push(t('quota.models', { count: group.members.length }));
  const resetsAt = parseInstant(group.resetsAt);
  if (resetsAt !== null) parts.push(t('quota.resets', { time: clockTimeWithDay(resetsAt) }));
  return parts.join(' · ');
}

export function createQuotas(providerId: string): QuotaHandle {
  const detailId = `quota-detail-${providerId}`;

  // --- collapsed ---------------------------------------------------------
  const chevron = el('span', { class: 'quota__chev', 'aria-hidden': 'true' });
  const summary = el('span', { class: 'quota__summary' });
  const toggle = el(
    'button',
    { type: 'button', class: 'quota__toggle', 'aria-expanded': 'false', 'aria-controls': detailId },
    chevron,
    summary,
  ) as HTMLButtonElement;

  // --- expanded ----------------------------------------------------------
  const lead = el('p', { class: 'quota__lead' });
  /**
   * The sentence that stops the model names below being read as claims about
   * the tools they are named after. It is rendered ABOVE the names, at the
   * same weight as the lead — not as a footnote under them — for the same
   * reason `cost.ts` puts its denial directly beneath the figure: a caveat
   * placed after the thing it qualifies has already been misread by the time
   * it is reached.
   */
  const denial = el('p', { class: 'quota__denial' });
  const groupList = el('div', { class: 'quota__groups' });
  const notes = el('div', { class: 'quota__notes' });
  const detail = el(
    'div',
    { class: 'quota__detail', id: detailId },
    lead,
    denial,
    groupList,
    notes,
  );
  detail.hidden = true;

  const root = el('div', { class: 'quota' }, toggle, detail);
  root.hidden = true;

  let expanded = false;
  function applyExpanded(): void {
    detail.hidden = !expanded;
    setAttr(toggle, 'aria-expanded', expanded ? 'true' : 'false');
    setAttr(root, 'data-expanded', expanded ? 'true' : 'false');
  }
  on(toggle, 'click', () => {
    expanded = !expanded;
    applyExpanded();
  });

  function renderGroups(
    groups: readonly ModelQuotaGroup[],
    selectedModel: string | null,
    selectedGroupIndex: number | null,
  ): void {
    replaceChildrenWith(
      groupList,
      groups.map((group, groupIndex) => {
        const head = el('p', { class: 'quota__head' }, groupHeadText(group));
        // The state ramp is right here and wrong in cost.ts: this IS distance
        // to a limit, which is what the ramp means, and it is the same kind of
        // claim the meter above makes. The composition bar in the cost block
        // is a share of a whole with no limit in it, which is why that one
        // stays off the ramp.
        setAttr(head, 'data-state', stateFor(group.usedPercentage));

        const members = el('ul', { class: 'quota__models' });
        for (const name of group.members) {
          // The selection is matched by INDEX and NAME together, so a name that
          // happened to appear in two groups is only marked in the one main
          // pointed at. The mark is the word "seçili", a text label on the
          // member — NEVER a figure. The pairing rule holds: this <li> carries
          // a name and "seçili", and no percentage on any code path.
          const isSelected =
            selectedModel !== null && groupIndex === selectedGroupIndex && name === selectedModel;
          if (isSelected) {
            const li = el(
              'li',
              { class: 'quota__model quota__model--selected' },
              el('span', { class: 'quota__model-name' }, name),
              el('span', { class: 'quota__sel' }, t('quota.selected')),
            );
            // Spoken as the name plus "seçili model", no figure — the group
            // heading above already carries the percentage.
            setAttr(li, 'aria-label', t('quota.selectedLabel', { name }));
            members.appendChild(li);
          } else {
            // A text node, and nothing else in the row. No figure is appended
            // here on any code path — see the header of this file.
            members.appendChild(el('li', { class: 'quota__model' }, name));
          }
        }

        // Grouped rather than a bare heading plus list, so a screen reader
        // hears which figure the names belong to instead of a loose list.
        const box = el('div', { class: 'quota__group', role: 'group' }, head, members);
        setAttr(
          box,
          'aria-label',
          t('quota.groupLabel', { head: groupHeadText(group) }),
        );
        return box;
      }),
    );
  }

  function renderNotes(detailData: ModelQuotaDetail, degraded: boolean): void {
    const nodes: HTMLElement[] = [];

    // ADR-001's honesty rule, applied to the INTERFACE rather than the number.
    // A figure decoded from an undocumented local store can go wrong in a way
    // a published one cannot: the format changes and nothing tells us. The
    // contract carries `provenance` precisely so this can be said rather than
    // averaged away, and saying it is the only thing that makes the figure
    // defensible at all.
    if (detailData.provenance === 'derived') {
      nodes.push(
        el(
          'p',
          { class: 'quota__note' },
          t('quota.derived'),
        ),
      );
    }

    if (degraded) {
      nodes.push(
        el(
          'p',
          { class: 'quota__note' },
          t('quota.degraded'),
        ),
      );
    }

    // Never a figure without the instant it was true at. The contract makes
    // `capturedAt` mandatory on this block for exactly that reason, and the
    // sanitiser drops the whole thing when it is missing.
    nodes.push(el('p', { class: 'quota__note quota__note--asof' }, asOf(detailData.capturedAt)));

    replaceChildrenWith(notes, nodes);
  }

  function update(
    detailData: ModelQuotaDetail | null,
    providerName: string,
    degraded = false,
  ): void {
    if (!detailData || detailData.groups.length === 0) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    setAttr(root, 'data-diverged', detailData.diverged ? 'true' : null);

    setText(summary, summaryText(detailData));
    setAttr(toggle, 'aria-label', spokenSummary(detailData, providerName));

    setText(lead, t('quota.lead'));
    // Deliberately does not suffix the provider's name: Turkish would need an
    // apostrophe and a vowel-harmonised suffix on a string that comes from a
    // snapshot, and getting that wrong on screen is worse than not doing it.
    setText(denial, t('quota.denial'));

    renderGroups(detailData.groups, detailData.selectedModel ?? null, detailData.selectedGroupIndex ?? null);
    renderNotes(detailData, degraded);
    applyExpanded();
  }

  return { el: root, update };
}
