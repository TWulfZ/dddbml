import { useMemo } from 'preact/hooks';
import type { RecordValue } from '../../shared/types';
import { Modal } from '../ui/Modal';
import { store, useAppStore } from '../state/store';

/** Read-only preview of a table's DBML `records` (spec 18). */
export function RecordsModal() {
  const name = useAppStore((s) => s.recordsTable);
  const schema = useAppStore((s) => s.schema);
  const close = () => store.getState().setRecordsTable(null);

  const data = useMemo(() => {
    if (!name) return null;
    const blocks = (schema.records ?? []).filter((r) => r.table === name);
    const table = schema.tables.find((t) => t.name === name);
    const typeOf = new Map(table?.columns.map((c) => [c.name, c.type]) ?? []);
    return { blocks, typeOf, title: table?.tableName ?? name };
  }, [name, schema]);

  const total = data?.blocks.reduce((n, b) => n + b.totalRows, 0) ?? 0;

  return (
    <Modal open={name != null} onClose={close} fit title={data ? `${data.title} · ${total} record${total === 1 ? '' : 's'}` : ''}>
      {data?.blocks.map((b, i) => (
        <div key={i} class="ddd-records">
          <table class="ddd-records__grid">
            <thead>
              <tr>
                {b.columns.map((c) => (
                  <th key={c}>
                    <span class="ddd-records__col">{c}</span>
                    <span class="ddd-records__type">{data.typeOf.get(c) ?? ''}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => <td key={c}><Cell value={cell} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {b.totalRows > b.rows.length ? (
            <p class="ddd-records__more">Showing {b.rows.length} of {b.totalRows} rows</p>
          ) : null}
        </div>
      ))}
    </Modal>
  );
}

function Cell({ value }: { value: RecordValue }) {
  if (value.v === null) return <span class="ddd-records__null">null</span>;
  if (value.t === 'expression') return <code class="ddd-records__expr">{String(value.v)}</code>;
  return <>{String(value.v)}</>;
}
