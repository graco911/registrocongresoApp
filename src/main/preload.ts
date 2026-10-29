import { contextBridge, ipcRenderer } from 'electron';
import { methods, type Api, type Reply } from '../shared/contracts';

const api = Object.fromEntries(methods.map(method => [method, async (input: unknown) => {
  const reply: Reply = await ipcRenderer.invoke('congress', method, input);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}])) as Api;
contextBridge.exposeInMainWorld('congress', api);
