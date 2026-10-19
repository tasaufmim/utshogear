import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast, Spinner, Modal, Empty } from '../ui';
import { useAuth } from '../auth';

type Category = {
  uuid: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  productCount: number;
};

export function CategoriesPage() {
  const toast = useToast();
  const { can } = useAuth();
  const [items, setItems] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const load = () =>
    api<{ data: Category[] }>('/categories')
      .then((r) => setItems(r.data))
      .catch((e) => toast(e.message, 'err'))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <div className="card">
        <div className="card-title">
          <div>
            <h2>Categories</h2>
            <div className="dim">Group products the way you think about them at the counter</div>
          </div>
          {can('manageProducts') && (
            <button className="btn primary" onClick={() => setEditing('new')}>
              + New category
            </button>
          )}
        </div>

        {loading ? (
          <div className="center" style={{ padding: 30 }}>
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <Empty icon="🏷" title="No categories yet" hint="Create your first one — Helmets, Oils, Lights…" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Products</th>
                  <th style={{ width: 170 }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.uuid}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td className="num">
                      <span className={`badge ${c.productCount === 0 ? 'warn' : 'ok'}`}>
                        {c.productCount}
                      </span>
                    </td>
                    <td className="right">
                      {can('manageProducts') && (
                        <>
                          <button className="btn sm" onClick={() => setEditing(c)}>
                            Edit
                          </button>{' '}
                          <button className="btn sm" onClick={() => setDeleting(c)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <CategoryModal
          value={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {deleting && (
        <Modal
          title="Delete category"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(null)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  try {
                    await api(`/categories/${deleting.uuid}`, { method: 'DELETE' });
                    toast('Category deleted', 'ok');
                    setDeleting(null);
                    load();
                  } catch (e: any) {
                    toast(e.message, 'err');
                  }
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>
            Delete <b>{deleting.name}</b>?
            {deleting.productCount > 0 && (
              <span className="err-text"> — this category still holds {deleting.productCount} products.</span>
            )}
          </p>
        </Modal>
      )}
    </>
  );
}

function CategoryModal({
  value,
  onClose,
  onSaved,
}: {
  value: Category | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(value?.name ?? '');
  const [sortOrder, setSort] = useState(value?.sortOrder ?? 0);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return toast('Enter a category name', 'err');
    setBusy(true);
    try {
      if (value) {
        await api(`/categories/${value.uuid}`, { method: 'PATCH', body: { name: name.trim(), sortOrder } });
        toast('Category updated', 'ok');
      } else {
        await api('/categories', { method: 'POST', body: { name: name.trim(), sortOrder } });
        toast('Category created', 'ok');
      }
      onSaved();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={value ? 'Edit category' : 'New category'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? <Spinner /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="grid">
        <div className="field">
          <label>Name</label>
          <input
            className="input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="e.g. Helmets"
          />
        </div>
        <div className="field">
          <label>Sort order</label>
          <input
            className="input"
            type="number"
            value={sortOrder}
            onChange={(e) => setSort(Number(e.target.value))}
          />
          <span className="hint">Lower numbers appear first</span>
        </div>
      </div>
    </Modal>
  );
}
