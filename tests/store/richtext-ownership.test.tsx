// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { closeHistory, undo, redo } from 'prosemirror-history';
import { ProsemirrorEditor } from '@/components/slide-renderer/components/element/ProsemirrorEditor';

const current = vi.hoisted(() => ({ view: null as EditorView | null }));
vi.mock('@/lib/prosemirror', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/prosemirror')>();
  return {
    ...original,
    initProsemirrorEditor: (...args: Parameters<typeof original.initProsemirrorEditor>) => {
      const view = original.initProsemirrorEditor(...args);
      current.view = view;
      return view;
    },
  };
});

let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  current.view = null;
  root = undefined;
});

async function render(
  value: string,
  onUpdate: (payload: { value: string; ignore: boolean }) => void,
) {
  if (!root) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(
      <ProsemirrorEditor
        elementId="text-a"
        value={value}
        defaultColor="#000"
        defaultFontName="Arial"
        editable
        onUpdate={onUpdate}
      />,
    ),
  );
}

test('document edits persist synchronously and use the current callback after rerender', async () => {
  const old = vi.fn();
  await render('<p>start</p>', old);
  await act(async () => current.view!.dispatch(current.view!.state.tr.insertText('first', 1)));
  expect(old).toHaveBeenCalledTimes(1);
  expect(old.mock.calls[0][0].value).toContain('firststart');
  const next = vi.fn();
  await render(old.mock.calls[0][0].value, next);
  await act(async () => current.view!.dispatch(current.view!.state.tr.insertText('second', 1)));
  expect(old).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
  expect(next.mock.calls[0][0].value).toContain('secondfirststart');
});

test('external undo replaces focused DOM without writing an old document back', async () => {
  const onUpdate = vi.fn();
  await render('<p>edited</p>', onUpdate);
  current.view!.focus();
  await render('<p>original</p>', onUpdate);
  expect(current.view!.dom.textContent).toBe('original');
  expect(onUpdate).not.toHaveBeenCalled();
});

test('unmount immediately after typing leaves no delayed update callback', async () => {
  const onUpdate = vi.fn();
  await render('<p>original</p>', onUpdate);
  await act(async () => current.view!.dispatch(current.view!.state.tr.insertText('saved ', 1)));
  expect(onUpdate).toHaveBeenCalledTimes(1);
  await act(async () => root!.unmount());
  root = undefined;
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(onUpdate).toHaveBeenCalledTimes(1);
});

test('external undo resets local history so Ctrl-Z cannot resurrect the replaced document', async () => {
  const onUpdate = vi.fn();
  await render('<p>original</p>', onUpdate);
  const view = current.view!;
  vi.spyOn(
    view as unknown as { scrollToSelection: () => void },
    'scrollToSelection',
  ).mockImplementation(() => {});
  view.focus();
  await act(async () => view.dispatch(view.state.tr.insertText('edited ', 1)));
  await render(onUpdate.mock.calls[0][0].value, onUpdate);
  await act(async () => view.dispatch(closeHistory(view.state.tr)));
  await render('<p>original</p>', onUpdate);
  onUpdate.mockClear();
  await act(async () => {
    expect(undo(view.state, view.dispatch)).toBe(false);
    expect(redo(view.state, view.dispatch)).toBe(false);
  });
  expect(view.dom.textContent).toBe('original');
  expect(onUpdate).not.toHaveBeenCalled();
  await act(async () => view.dispatch(view.state.tr.insertText('new ', 1)));
  expect(onUpdate.mock.calls[0][0].value).toContain('new original');
  await act(async () => expect(undo(view.state, view.dispatch)).toBe(true));
  expect(view.dom.textContent).toBe('original');
  await act(async () => expect(redo(view.state, view.dispatch)).toBe(true));
  expect(view.dom.textContent).toBe('new original');
});
