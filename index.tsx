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
        description: "WebSocket Port (First WebSocketControl instance must listen on this port)"
    }
});

let socket: WebSocket | null = null;
let reconnectTimeout: any = null;

function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

    const port = settings.store.port;
    socket = new WebSocket(`ws://127.0.0.1:${port}/?client=Vencord`);

    socket.onopen = () => {
        console.log("WebSocketControl connected");
        sendVoiceState();
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (e) {
            console.error("WebSocketControl parse error", e);
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
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const user = UserStore.getCurrentUser();
    if (!user) return;

    const voiceState = VoiceStateStore.getVoiceStateForUser(user.id);

    const payload = {
        event: "VOICE_STATE_UPDATE",
        data: {
            self_mute: voiceState?.selfMute || false,
            self_deaf: voiceState?.selfDeaf || false,
            mute: voiceState?.mute || false,
            deaf: voiceState?.deaf || false,
            channel_id: voiceState?.channelId || null,
        }
    };
    console.log("WebSocketControl: Sending voice state", payload);
    socket.send(JSON.stringify(payload));
}

export default definePlugin({
    name: "WebSocketControl",
    description: "Connects via WebSocket to control mute/deaf status.",
    authors: [{ name: "KuroZantetsuken", id: 0n }],
    settings,

    start() {
        try {
            MediaEngineActions = findByProps("toggleSelfMute") ?? findByCode("AUDIO_TOGGLE_SELF_MUTE");
        } catch (e) {
            console.error("WebSocketControl: Error finding MediaEngineActions", e);
        }
        connect();
    },

    stop() {
        if (socket) {
            socket.onclose = null;
            socket.close();
            socket = null;
        }
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
