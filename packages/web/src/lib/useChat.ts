import { create } from 'zustand';
import { createChatStore, type ChatState } from './store.js';

export const useChat = create<ChatState>((set, get) => createChatStore(set, get));
