import type { Ref } from '../../shared/types';

/** Shared geometry keeps the diagram and exported SVG cardinalities identical. */
export const REF_MARKERS = [false, true].flatMap((start) =>
  [false, true].flatMap((many) => [false, true].map((optional) => {
    const id = `ddd-mk-${many ? 'many' : 'one'}${optional ? '-optional' : ''}${start ? '-s' : ''}`;
    // End marker: table at x=21; the crow's foot fans out toward the table.
    // The inner bar/circle gives the minimum cardinality, independently of the maximum.
    const d = many
      ? `M20,2 L10,6 L20,10${optional ? '' : ' M6,2 L6,10'}`
      : `M18,2 L18,10${optional ? '' : ' M12,2 L12,10'}`;
    return { id, start, optional, d };
  })),
);

export function refMarker(endpoint: Pick<Ref['source'], 'relation' | 'optional'> | undefined, start = false): string {
  return `url(#ddd-mk-${endpoint?.relation === '*' ? 'many' : 'one'}${endpoint?.optional ? '-optional' : ''}${start ? '-s' : ''})`;
}

export function refColor(ref: Ref | undefined, layout: { color?: string } | undefined): string | undefined {
  return layout?.color ?? ref?.color;
}

export function refMarkersSvg(circleFill = '#ffffff', stroke = 'currentColor'): string {
  return REF_MARKERS.map(({ id, start, optional, d }) =>
    `<marker id="${id}" viewBox="0 0 24 12" refX="${start ? '3' : '21'}" refY="6" markerWidth="24" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">` +
    `<g${start ? ' transform="translate(24 0) scale(-1 1)"' : ''}><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4"/>` +
    (optional ? `<circle cx="4" cy="6" r="3" fill="${circleFill}" stroke="${stroke}" stroke-width="1.4"/>` : '') +
    '</g></marker>',
  ).join('');
}

/** Readable ref metadata for the diagram hit target and standalone SVG. */
export function refDescription(ref: Ref): string {
  const endpoint = (e: Ref['source']) => `${e.table}.(${e.columns.join(', ')}) [${e.optional ? '0..' : ''}${e.relation}]`;
  return [ref.name, ref.inactive ? 'Inactive relationship' : null, `${endpoint(ref.source)} — ${endpoint(ref.target)}`,
    ref.onDelete ? `delete: ${ref.onDelete}` : null,
    ref.onUpdate ? `update: ${ref.onUpdate}` : null,
  ].filter(Boolean).join('\n');
}
