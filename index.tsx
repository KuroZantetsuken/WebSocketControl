import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import definePlugin from "@utils/types";
import { findByProps, findByCode } from "@webpack";
import { UserStore, VoiceStateStore } from "@webpack/common";

let MediaEngineActions: any;

const settings = definePluginSettings({
    port: {
        type: OptionType.NUMBER,
        default: 8124,
        description: "WebSocket Port (Macro Deck Plugin must listen on this port)"
    }
});

let socket: WebSocket | null = null;
let reconnectTimeout: any = null;

function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const port = settings.store.port;
    // We append ?client=Vencord so the server knows who is connecting
    socket = new WebSocket(`ws://127.0.0.1:${port}/?client=Vencord`);

    socket.onopen = () => {
        sendVoiceState();
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (e) {
            console.error("MacroDeckServer parse error", e);
        }
    };

    socket.onclose = () => {
        socket = null;
        reconnectTimeout = setTimeout(connect, 5000);
    };

    socket.onerror = (e) => {
        // Connection errors are handled by onclose usually
    };
}

function handleMessage(data: any) {
    if (!MediaEngineActions) return;

    if (data.command === "TOGGLE_MUTE") {
        MediaEngineActions.toggleSelfMute();
    } else if (data.command === "TOGGLE_DEAF") {
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
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const user = UserStore.getCurrentUser();
    if (!user) return;

    const voiceState = VoiceStateStore.getVoiceStateForUser(user.id);

    socket.send(JSON.stringify({
        event: "VOICE_STATE_UPDATE",
        data: {
            self_mute: voiceState?.selfMute || false,
            self_deaf: voiceState?.selfDeaf || false,
            mute: voiceState?.mute || false,
            deaf: voiceState?.deaf || false,
            channel_id: voiceState?.channelId || null,
        }
    }));
}

export default definePlugin({
    name: "MacroDeckServer",
    description: "Connects to Macro Deck via WebSocket to control mute/deaf status. Requires a custom Macro Deck plugin acting as a WebSocket Server.",
    authors: [{ name: "Roo", id: 0n }],
    settings,

    start() {
        try {
            MediaEngineActions = findByProps("toggleSelfMute") ?? findByProps("toggleSelfDeaf") ?? findByCode("AUDIO_TOGGLE_SELF_MUTE");
        } catch (e) {
            console.error("MacroDeckServer: Error finding MediaEngineActions", e);
        }
        connect();
    },

    stop() {
        if (socket) {
            // Prevent reconnection attempt
            socket.onclose = null;
            socket.close();
            socket = null;
        }
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
    },

    flux: {
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
