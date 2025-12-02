# Macro Deck Server for Vencord

This plugin connects Vencord (or Vesktop) to Macro Deck via WebSocket. 

## Requirements

1.  **Macro Deck 2** installed.
2.  **Modified Macro Deck Plugin**:
    *   The source code for the modified plugin is included in the `.MacroDeckPlugin/` directory within this folder.
    *   You must build this plugin (using Visual Studio or `dotnet build`) and install it into Macro Deck.
    *   This modified plugin listens on `ws://127.0.0.1:8124` instead of using Discord IPC.

## Communication Protocol

### From Vencord to Macro Deck (Events)

Vencord sends JSON payloads when voice state changes:

```json
{
    "event": "VOICE_STATE_UPDATE",
    "data": {
        "self_mute": boolean,
        "self_deaf": boolean,
        "mute": boolean,
        "deaf": boolean,
        "channel_id": string | null
    }
}
```

### From Macro Deck to Vencord (Commands)

Macro Deck should send JSON payloads to control Vencord:

```json
{ "command": "TOGGLE_MUTE" }
{ "command": "TOGGLE_DEAF" }
{ "command": "SET_MUTE", "value": true }
{ "command": "SET_DEAF", "value": true }
```

## How to use

1.  **Build the C# Plugin**:
    *   Navigate to `.MacroDeckPlugin/`.
    *   Run `dotnet build -c Release`.
    *   Copy the output DLLs to your Macro Deck plugins folder (or use the build script if configured).
2.  **Enable Vencord Plugin**:
    *   Enable `MacroDeckServer` in Vencord settings.
3.  **Start Macro Deck**:
    *   The Macro Deck plugin will start the WebSocket server on port 8124.
    *   Vencord will connect automatically.
