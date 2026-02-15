import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import definePlugin from "@utils/types";
import { findByProps, findByCode } from "@webpack";
import { UserStore, VoiceStateStore } from "@webpack/common";

let MediaEngineActions: any;
let MediaEngineStore: any;

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        default: 8124,
        description: "WebSocket Base Port (First WebSocketControl instance must listen on this port)"
    },
    numberOfPorts: {
        type: OptionType.NUMBER,
        default: 1,
        description: "Number of WebSocket ports to connect to (incrementing from Base Port)",
    }
});

const sockets: (WebSocket | null)[] = [];
const socketStates: { retryCount: number, nextRetryTime: number }[] = [];
let reconnectTimeout: any = null;
let lastBasePort = -1;

function connect() {
    const basePort = settings.store.port;
    const numPorts = settings.store.numberOfPorts;

    if (lastBasePort !== -1 && lastBasePort !== basePort) {
        // Port changed, close all and reset
        for (const s of sockets) s?.close();
        sockets.length = 0;
        socketStates.length = 0;
    }
    lastBasePort = basePort;

    // Ensure arrays are correct size
    while (sockets.length < numPorts) {
        sockets.push(null);
        socketStates.push({ retryCount: 0, nextRetryTime: 0 });
    }
    while (sockets.length > numPorts) {
        const s = sockets.pop();
        if (s) s.close();
        socketStates.pop();
    }

    const now = Date.now();

    for (let i = 0; i < numPorts; i++) {
        const socket = sockets[i];
        const state = socketStates[i];

        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            // Reset retry count on successful connection
            if (socket.readyState === WebSocket.OPEN) {
                state.retryCount = 0;
                state.nextRetryTime = 0;
            }
            continue;
        }

        // Check if we should retry
        if (state.retryCount >= 10) continue;
        if (now < state.nextRetryTime) continue;

        const port = basePort + i;
        const newSocket = new WebSocket(`ws://127.0.0.1:${port}/?client=Vencord`);
        sockets[i] = newSocket;

        // Calculate next retry delay (exponential backoff)
        state.retryCount++;
        // 1s, 2s, 4s, 8s...
        const delay = 1000 * Math.pow(2, state.retryCount - 1);
        state.nextRetryTime = now + delay;

        newSocket.onopen = () => {
            console.log(`WebSocketControl: WebSocket connected on port ${port}`);
            state.retryCount = 0;
            state.nextRetryTime = 0;
            sendVoiceState();
        };

        newSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log(`WebSocketControl: Received command on port ${port}`, data);
                handleMessage(data);
            } catch (e) {
                console.error("WebSocketControl parse error", e);
            }
        };

        newSocket.onclose = () => {
            if (sockets[i] === newSocket) {
                sockets[i] = null;
            }
        };

        newSocket.onerror = (e) => {
            // Connection errors are handled by onclose usually
        };
    }
    
    // Schedule next reconnection check
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connect, 1000);
}

function handleMessage(data: any) {
    if (!MediaEngineActions) {
        console.error("WebSocketControl: MediaEngineActions not found!");
        return;
    }

    if (data.command === "TOGGLE_MUTE") {
        console.log("WebSocketControl: Toggling mute");
        MediaEngineActions.toggleSelfMute();
    } else if (data.command === "TOGGLE_DEAF") {
        console.log("WebSocketControl: Toggling deaf");
        MediaEngineActions.toggleSelfDeaf();
    } else if (data.command === "SET_MUTE") {
        const user = UserStore.getCurrentUser();
        if (!user) return;
        const isMuted = VoiceStateStore.getVoiceStateForUser(user.id)?.selfMute ?? false;
        if (isMuted !== data.value) MediaEngineActions.toggleSelfMute();
    } else if (data.command === "SET_DEAF") {
        const user = UserStore.getCurrentUser();
        if (!user) return;
        const isDeaf = VoiceStateStore.getVoiceStateForUser(user.id)?.selfDeaf ?? false;
        if (isDeaf !== data.value) MediaEngineActions.toggleSelfDeaf();
    }
}

function sendVoiceState() {
    // Use MediaEngineStore for global mute/deaf state (works outside calls)
    const selfMute = MediaEngineStore ? MediaEngineStore.isSelfMute() : VoiceStateStore.isSelfMute();
    const selfDeaf = MediaEngineStore ? MediaEngineStore.isSelfDeaf() : VoiceStateStore.isSelfDeaf();
    
    const user = UserStore.getCurrentUser();
    const voiceState = user ? VoiceStateStore.getVoiceStateForUser(user.id) : null;

    const payload = {
        event: "VOICE_STATE_UPDATE",
        data: {
            self_mute: selfMute,
            self_deaf: selfDeaf,
            mute: voiceState?.mute || false,
            deaf: voiceState?.deaf || false,
            channel_id: voiceState?.channelId || null,
        }
    };
    console.log("WebSocketControl: Sending voice state", payload);

    for (const socket of sockets) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(payload));
        }
    }
}

export default definePlugin({
    name: "WebSocketControl",
    description: "Connects via WebSocket to control mute/deaf status.",
    authors: [{ name: "KuroZantetsuken", id: 0n }],
    settings,

    start() {
        try {
            MediaEngineActions = findByProps("toggleSelfMute") ?? findByCode("AUDIO_TOGGLE_SELF_MUTE");
            MediaEngineStore = findByProps("isSelfMute");
        } catch (e) {
            console.error("WebSocketControl: Error finding MediaEngine stores/actions", e);
        }
        connect();
    },

    stop() {
        for (let i = 0; i < sockets.length; i++) {
            const socket = sockets[i];
            if (socket) {
                socket.onclose = null;
                socket.close();
            }
        }
        sockets.length = 0;
        socketStates.length = 0;
        lastBasePort = -1;
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
    },

    flux: {
        VOICE_STATE_UPDATE() {
            sendVoiceState();
        },
        VOICE_STATE_UPDATES() {
            sendVoiceState();
        },
        AUDIO_TOGGLE_SELF_MUTE() {
            sendVoiceState();
        },
        AUDIO_TOGGLE_SELF_DEAF() {
            sendVoiceState();
        }
    }
});
