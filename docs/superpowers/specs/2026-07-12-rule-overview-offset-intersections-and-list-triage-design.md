# Rule Overview, Offset Intersections, and List Triage Design

**Date:** 2026-07-12

## Goal

Make existing lane-navigation annotations easier to audit and revisit. Annotators must be able to inspect every populated field of a movement rule, intentionally relate roads in a real-world staggered intersection that OSM does not model as one connected node, and locate problematic work from the segment list.

## Scope

This change applies to the GitHub Pages annotation UI in `docs/`. It adds:

1. an expanded rule overview for the selected intersection;
2. an explicit offset-intersection target relation;
3. `has-notes` and `offset-intersection` badges in the segment list;
4. a multi-select badge filter with AND/OR matching;
5. per-browser favourite intersections, including a list badge and filter.

UI labels remain Chinese: `has-notes` is shown as "has notes", `offset-intersection` as "offset intersection", and `favourite` as "my favourite". Existing annotation status, candidate priority, GitHub event storage, and canonical JSONL compaction remain compatible.

## Expanded Rule Overview

The selected-intersection overview renders one card per stored movement rule. It displays populated fields rather than collapsing a rule to its movement, target road, motorcycle rule, and waiting-zone status.

Each card shows:

- OSM approach direction;
- movement and target-road name;
- target OSM way when available;
- vehicle movement rule;
- motorcycle turn rule;
- two-stage sign status;
- waiting-zone status and position;
- relation type and reason when the target is an offset intersection;
- data origin (`context_v2` or legacy).

Known-but-unverified fields render as `unknown`; absent optional fields are omitted. Legacy records stay visible using the existing precedence rule: a newer exact context replaces the matching legacy direction, but legacy rules remain visible where no exact context exists.

## Offset-Intersection Target Relation

### Default behaviour

Ctrl+click continues to select a connected target way at the chosen OSM intersection. This is the ordinary relation and requires no extra metadata.

### Exception flow

When Ctrl+click selects a different road that is not in the selected intersection's `connected_ways`, the UI must not silently accept it. It presents a confirmation dialog with these choices:

- cancel;
- create an offset-intersection relation with reason `staggered_cross_intersection`;
- create an offset-intersection relation with reason `osm_geometry_missing`;
- create an offset-intersection relation with reason `other`, which requires a non-empty explanation.

There is no distance limit. The confirmation and the persistent relation metadata, rather than a geometric threshold, protect the dataset from accidental arbitrary targets.

After confirmation, the clicked road becomes the target and the rule is saved normally. An offset relation is represented inside that rule as:

```json
"target_relation": {
  "kind": "offset_intersection",
  "reason": "staggered_cross_intersection",
  "note": null
}
```

For `other`, `note` contains the required explanation. Connected targets omit `target_relation`. The original `applies_to_intersection_key` remains the entrance being annotated and `to_segment_key` remains the selected destination way, so existing consumers retain their normal route semantics.

## Segment-list Badges

The list retains its existing annotated, checked-with-no-rules, and priority badges. It additionally derives these badges from all persisted annotations for the segment, across directions and intersection contexts:

| Badge | Condition |
| --- | --- |
| `has-notes` | A segment annotation's `annotation_metadata.note` is non-empty, or any intersection-context annotation's `osm_review_note` is non-empty. |
| `offset-intersection` | At least one movement rule has `target_relation.kind = "offset_intersection"`. |
| `favourite` | At least one nearby intersection for the segment is stored as a favourite in this browser. |

The badge title reports the relevant count and source category where applicable. The list remains a summary: selecting the segment exposes the full note and rule details in the existing detail controls.

## Badge Filter

Next to the existing candidate-scope control, add a tag-filter popover containing checkboxes for the existing status badges plus `has-notes`, `offset-intersection`, and `favourite`.

The popover includes an AND/OR selector and a clear action.

- **AND** is the default. A segment must carry every selected badge.
- **OR** includes a segment carrying any selected badge.
- With no selected badge, the filter does not constrain results.
- Badge matching is combined with, not a replacement for, the existing candidate-scope selector.

The closed control states the number of selected tags and the active mode. Every matching segment continues to display all of its badges, not merely the badges that matched the filter.

## Favourite Intersections

Each nearby-intersection card has a toggle button for adding or removing that intersection from the local favourites list.

Favourites are a local triage queue, not shared annotation data. They are stored in browser `localStorage` under a versioned LanePilot key as a set of:

```text
nav_segment_key@nav_intersection_key
```

This intentionally distinguishes the same OSM node approached from different road segments. Toggling a favourite updates the nearby-intersection card, the selected segment's `favourite` badge, and active list filtering immediately. Favourites persist across reloads in the same browser but do not sync to GitHub, other browsers, or other team members.

## Error Handling

- A non-connected Ctrl+click that is cancelled leaves the target controls and draft unchanged.
- `other` cannot be confirmed without an explanation.
- Invalid or missing target segment keys cannot create an offset relation.
- Malformed old `target_relation` data renders as unknown without preventing the rest of the annotation from loading.
- Unavailable or malformed favourite `localStorage` data is ignored and replaced with an empty local set; no annotation data is affected.

## Verification

Add or extend automated tests for:

1. expanded-overview rows, field visibility, unknown values, and legacy/context precedence;
2. connected Ctrl+click regression behaviour;
3. non-connected Ctrl+click cancellation, every allowed offset reason, required `other` explanation, save, reload, and ordinary-target compatibility;
4. badge derivation for segment notes, intersection OSM-review notes, offset relations, and existing statuses;
5. AND and OR filter matching, clear behaviour, and interaction with candidate scope;
6. favourite toggle, reload persistence, segment-level badge derivation, and favourite filtering;
7. existing annotation-model and web-adapter test suites.

Manual smoke testing must confirm the complete flow in the deployed UI: annotate a staggered intersection, reload it, find it through the offset-intersection badge, mark its intersection as a favourite, then find it again using an AND filter with offset-intersection and favourite.

## Non-goals

- No change to how candidate priority is calculated.
- No new shared assignment, issue-tracking, or synchronised favourite system.
- No automatic inference that nearby non-connected roads form a real intersection.
- No distance cap for offset-intersection relations.
- No new standalone filter for free-text notes.
