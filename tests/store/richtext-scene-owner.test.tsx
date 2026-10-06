// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import { undo } from 'prosemirror-history';
import type { SlideContent, Scene } from '@/lib/types/stage';
import { useStageStore } from '@/lib/store/stage';
import { useSceneData } from '@/lib/contexts/scene-context';
import { ProsemirrorEditor } from '@/components/slide-renderer/components/element/ProsemirrorEditor';
import { CanvasArea } from '@/components/canvas/canvas-area';
import { defaultTheme } from '@/e2e/fixtures/test-data/scene-content';

const current = vi.hoisted(() => ({ view: null as EditorView | null }));
vi.mock('@/lib/prosemirror', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/prosemirror')>();
  return { ...original, initProsemirrorEditor: (...args: Parameters<typeof original.initProsemirrorEditor>) => {
    const view = original.initProsemirrorEditor(...args); current.view = view; return view;
  } };
});
// Layout-only collaborators are omitted. The owning CanvasArea/SceneProvider,
// Store, callbacks, ProseMirror document/history, and DOM are real.
vi.mock('@/components/whiteboard', () => ({ Whiteboard: () => null }));
vi.mock('@/components/canvas/canvas-toolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/stage/scene-renderer', () => ({ SceneRenderer: () => <OwningEditor /> }));
function OwningEditor() {
  const { sceneData, updateSceneData } = useSceneData<SlideContent>();
  const text = sceneData.canvas.elements[0] as { id: string; content: string };
  return <ProsemirrorEditor elementId={text.id} value={text.content} defaultColor="#000" defaultFontName="Arial" editable
    onUpdate={({value}) => updateSceneData((draft) => { (draft.canvas.elements[0] as {content:string}).content = value; })} />;
}
const noop = () => {};
function Host() {
  const currentScene = useStageStore((state) => state.scenes.find((scene) => scene.id === state.currentSceneId) || null);
  return <CanvasArea currentScene={currentScene} mode="autonomous" currentSceneIndex={0} scenesCount={2} engineState="idle"
    isLiveSession={false} whiteboardOpen={false} sidebarCollapsed={false} chatCollapsed={false} hideToolbar
    onToggleSidebar={noop} onToggleChat={noop} onPrevSlide={noop} onNextSlide={noop} onPlayPause={noop}
    onWhiteboardClose={noop} isPresenting={false} onTogglePresentation={noop} />;
}
function scene(id: string, stageId: string, content: string): Scene {
  return { id, stageId, type:'slide', title:id, order:0, createdAt:1, updatedAt:1,
    content:{type:'slide',canvas:{id:'slide', viewportSize:1000,viewportRatio:0.5625,theme:defaultTheme,
      elements:[{type:'text',id:'shared-text-id',content,left:0,top:0,width:100,height:100,rotate:0,defaultColor:'#000',defaultFontName:'Arial'}]}} };
}
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root=undefined; current.view=null; });
for (const owner of ['scene','stage'] as const) {
  test(`identical HTML and element IDs have isolated history after ${owner} switch`, async () => {
    useStageStore.setState({stage:{id:'A',name:'A',createdAt:1,updatedAt:1},scenes:[scene('one','A','<p>original</p>'),scene('two','A','<p>edited original</p>')],currentSceneId:'one'});
    host=document.createElement('div');document.body.append(host);root=createRoot(host);
    await act(async () => root!.render(<Host />));
    const previous=current.view!;
    vi.spyOn(previous as unknown as {scrollToSelection:()=>void},'scrollToSelection').mockImplementation(noop);
    await act(async () => previous.dispatch(previous.state.tr.insertText('edited ',1)));
    expect(previous.dom.textContent).toBe('edited original');
    await act(async () => {
      if (owner==='scene') useStageStore.getState().setCurrentSceneId('two');
      else useStageStore.setState({stage:{id:'B',name:'B',createdAt:1,updatedAt:1},scenes:[scene('one','B','<p>edited original</p>')],currentSceneId:'one'});
    });
    const next=current.view!;
    vi.spyOn(next as unknown as {scrollToSelection:()=>void},'scrollToSelection').mockImplementation(noop);
    await act(async () => expect(undo(next.state,next.dispatch)).toBe(false));
    expect(next.dom.textContent).toBe('edited original');
    expect(next).not.toBe(previous);
    await act(async () => next.dispatch(next.state.tr.insertText('new ',1)));
    expect(next.dom.textContent).toBe('new edited original');
    const updated = useStageStore.getState().getCurrentScene()!.content as SlideContent;
    expect((updated.canvas.elements[0] as {content:string}).content).toContain('new edited original');
    await act(async () => expect(undo(next.state,next.dispatch)).toBe(true));
    expect(next.dom.textContent).toBe('edited original');
    const restored = useStageStore.getState().getCurrentScene()!.content as SlideContent;
    expect((restored.canvas.elements[0] as {content:string}).content).toContain('edited original');
    expect((restored.canvas.elements[0] as {content:string}).content).not.toContain('new ');
  });
}
