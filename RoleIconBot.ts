import { Stream } from "stream";
import { BufferResolvable, ChatInputCommandInteraction, CommandInteraction, CreateRoleOptions, EditRoleOptions, EmbedBuilder, GatewayIntentBits, GuildEmoji, GuildMember, GuildMemberManager, Role, SlashCommandBuilder } from "discord.js";
import { BotInterface } from "../../BotInterface";
import { readYamlConfig } from "../../ConfigUtils";
import { RoleIconConfig } from "./RoleIconConfig";

export class RoleIconBot implements BotInterface {
    private static readonly CMD_ROLEICON = "roleicon";
    private static readonly SUBCMD_SET_EMOJI = "emoji";
    private static readonly SUBCMD_SET_OPT_EMOJI = "emoji";
    private static readonly SUBCMD_SET_IMAGE = "image";
    private static readonly SUBCMD_SET_OPT_IMAGE = "image";
    private static readonly SUBCMD_CLEAR = "clear";
    private static readonly REGEX_UNICODE_EMOJI = /\p{Emoji_Presentation}{1}/u;
    private static readonly REGEX_DISCORD_EMOJI = /<:.+:[0-9]+>/;

    intents: GatewayIntentBits[];
    commands: [SlashCommandBuilder];
    private slashRoleIcon: SlashCommandBuilder;
    private config!: RoleIconConfig;

    constructor() {
        this.intents = [GatewayIntentBits.Guilds];
        this.slashRoleIcon = new SlashCommandBuilder()
            .setName(RoleIconBot.CMD_ROLEICON)
            .setDescription("Sets or removes your role icon.")
            .addSubcommand(subcommand =>
                subcommand
                    .setName(RoleIconBot.SUBCMD_SET_EMOJI)
                    .setDescription("Sets your role icon with an emoji.")
                    .addStringOption(option =>
                        option
                            .setName(RoleIconBot.SUBCMD_SET_OPT_EMOJI)
                            .setDescription("Emoji to use as your role icon.")
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName(RoleIconBot.SUBCMD_SET_IMAGE)
                    .setDescription("Sets your role icon with an image you upload.")
                    .addAttachmentOption(option =>
                        option
                            .setName(RoleIconBot.SUBCMD_SET_OPT_IMAGE)
                            .setDescription("Image to use as your role icon")
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName(RoleIconBot.SUBCMD_CLEAR)
                    .setDescription("Clears your role icon.")
            ) as SlashCommandBuilder;
        this.commands = [this.slashRoleIcon];
    }

    async processCommand(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand() || interaction.commandName !== RoleIconBot.CMD_ROLEICON) {
            return;
        }

        console.log(`[RoleIconBot]: got interaction: ${interaction}`);
        try {
            switch(interaction.options.getSubcommand()) {
                case RoleIconBot.SUBCMD_SET_EMOJI:
                    await this.handleSetEmoji(interaction);
                    break;
                case RoleIconBot.SUBCMD_SET_IMAGE:
                    await this.handleSetImage(interaction);
                    break;
                case RoleIconBot.SUBCMD_CLEAR:
                    await this.handleClear(interaction);
                    break;
            }
        } catch (error) {
            console.error(`[RoleIconBot] Uncaught error in processSlashCommand(): ${error}`);
        }
    }

    async init(): Promise<string | null> {
        try {
            this.config = await readYamlConfig<RoleIconConfig>(import.meta, "config.yaml");
        } catch (error) {
            const errMsg = `[RoleIconBot] Unable to read config: ${error}`;
            console.error(errMsg);
            return errMsg;
        }

        return null;
    }

    async handleSetImage(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            const member = interaction.member as GuildMember;
            const attachment = interaction.options.getAttachment(RoleIconBot.SUBCMD_SET_OPT_IMAGE);
            if (attachment === null) {
                console.error(`[RoleIconBot] Error in handleSetImage(): Empty attachment for ${member.id}`);
                await this.sendErrorMessage(interaction, "No attachment receieved.");
                return;
            }

            console.log(`[RoleIconBot] handleSetImage() from member ${member.id} with attachment URL ${attachment.url}`);
            const contentType = attachment.contentType;
            if (contentType!.indexOf("image") < 0) {
                console.error(`[RoleIconBot] Error in handleSetImage(): Non-image attachment for ${member.id}. URL is ${attachment.url}`);
                await this.sendErrorMessage(interaction, "Non-image attachment received.");
                return;
            }

            let buffer = attachment.attachment;
            if (!this.isBufferResolvable(buffer)) {
                try {
                    buffer = await this.streamToBuffer(buffer);
                } catch (err) {
                    console.error(`[RoleIconBot] Error while calling streamToBuffer(): ${err}`);
                    await this.sendErrorMessage(interaction, "Error while processing attachment.");
                    return;
                }
            }

            const result = await this.createOrUpdateRole(member, buffer, interaction.guild!.members);
            if (typeof(result) === "string") {
                await this.sendErrorMessage(interaction, result);
                return;
            }

            await interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle("Success")
                    .setDescription(`Set ${member}'s role icon to ${attachment.url}.`)
                    .setColor(0x00FF00)
            ], ephemeral: true});

            console.log(`[RoleIconBot] handleSetImage() success for ${member.id}`);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[RoleIconBot] Error in handleSetImage(): ${error}`);
                await this.sendErrorMessage(interaction, `Error setting role icon: ${error.message}`);
                return;
            }

            const unknown = `Unknown error: ${error}`;
            console.error(`[RoleIconBot] Error in handleSetImage(): ${unknown}`);
            await this.sendErrorMessage(interaction, "Unknown error while creating role. Bot owner should check logs.");
        }
    }

    async handleSetEmoji(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            const member = interaction.member as GuildMember;
            const emojiStr = interaction.options.getString(RoleIconBot.SUBCMD_SET_OPT_EMOJI, true).trim();
            console.log(`[RoleIconBot] handleSetEmoji() with emoji string ${emojiStr} from member ${member.id}`);

            const possibleUnicodeEmoji = RoleIconBot.REGEX_UNICODE_EMOJI.test(emojiStr);
            const possibleDiscordEmoji = RoleIconBot.REGEX_DISCORD_EMOJI.test(emojiStr);
            if (!possibleUnicodeEmoji && !possibleDiscordEmoji) {
                await this.sendErrorMessage(interaction, `Invalid emoji ${emojiStr} passed in.`);
                return;
            }

            let newEmoji: GuildEmoji | string;
            if (possibleDiscordEmoji) {
                const emojiIdSplit = emojiStr.split(":")[2];
                const emojiId = emojiIdSplit.substring(0, emojiIdSplit.indexOf(">"));
                try {
                    newEmoji = await interaction.guild!.emojis.fetch(emojiId);
                } catch (error) {
                    console.error(`[RoleIconBot] Error fetching Discord emoji: ${error}`);
                    await this.sendErrorMessage(interaction, `Error while finding Discord emoji ${emojiStr}. Emoji may not exist in this guild or is invalid.`);
                    return;
                }
            } else {
                const emojiArr = Array.from(emojiStr);
                newEmoji = emojiArr[0];
            }

            const result = await this.createOrUpdateRole(member, newEmoji, interaction.guild!.members);
            if (typeof(result) === "string") {
                await this.sendErrorMessage(interaction, result);
                return;
            }

            await interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle("Success")
                    .setDescription(`Set ${member}'s role icon to ${newEmoji}.`)
                    .setColor(0x00FF00)
            ], ephemeral: true});

            console.log(`[RoleIconBot] handleSetEmoji() success for ${member.id}`);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[RoleIconBot] Error in handleSetEmoji(): ${error}`);
                await this.sendErrorMessage(interaction, `Error setting role icon: ${error.message}`);
                return;
            }

            const unknown = `Unknown error: ${error}`;
            console.error(`[RoleIconBot] Error in handleSetEmoji(): ${unknown}`);
            await this.sendErrorMessage(interaction, "Unknown error while creating role. Bot owner should check logs.");
        }
    }

    async handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            const member = interaction.member as GuildMember;
            console.log(`[RoleIconBot] Got clear subcommand from member ${member.id}`);
            const result = await this.deleteRole(member);
            if (typeof(result) === "string") {
                await this.sendErrorMessage(interaction, `Failed to delete role: ${result}`);
                return;
            }

            await interaction.reply({ embeds: [
                new EmbedBuilder()
                    .setTitle("Success")
                    .setDescription(`Cleared icon role for ${member.toString()}`)
                    .setColor(0x00FF00)
            ], ephemeral: true});

            console.log("[RoleIconBot] handleClear() success");
        } catch (error) {
            console.error(`[RoleIconBot] Error in handleClear(): ${error}`);
            await this.sendErrorMessage(interaction, "Unknown error while clearing role. Bot owner should check logs.");
        }
    }

    /**
     * Tries to find a role icon role
     * @param member The discord.js member
     * @returns Role if found, null if not
     */
    async findRole(member: GuildMember): Promise<Role | null> {
        const roleName = this.config.prefix + member.id;

        try {
            const role = member.guild.roles.cache.find((val) => val.name === roleName);
            if (role === undefined) {
                return null;
            }

            console.log(`[RoleIconBot] Found role: ${roleName}`);
            return role;
        } catch (error) {
            console.error(`[RoleIconBot] Error while finding role: ${error}`);
            return null;
        }
    }

    /**
     * Creates or updates an existing role. Also sets the role for the member.
     * @param member The discord.js member
     * @param icon The icon to set for the role
     * @param manager The discord.js GuildMemberManager
     * @returns The Role if created or properly updated, string with reason if failed
     */
    async createOrUpdateRole(member: GuildMember, icon: CreateRoleOptions["icon"], manager: GuildMemberManager): Promise<Role | string> {
        const roleName = this.config.prefix + member.id;

        try {
            let role = await this.findRole(member);
            if (role === null) {
                const newRoleData: CreateRoleOptions = {
                    name: roleName,
                    hoist: false,
                    position: Number.MAX_SAFE_INTEGER,
                    permissions: undefined,
                    mentionable: false,
                };

                if (typeof(icon) === "string" && RoleIconBot.REGEX_UNICODE_EMOJI.test(icon)) {
                    newRoleData.unicodeEmoji = icon;
                } else {
                    newRoleData.icon = icon;
                }

                role = await member.guild.roles.create(newRoleData);

                await manager.addRole({
                    user: member.id,
                    role: role
                });
            } else {
                const updatedRoleData: EditRoleOptions = {};
                if (typeof(icon) === "string" && RoleIconBot.REGEX_UNICODE_EMOJI.test(icon)) {
                    updatedRoleData.unicodeEmoji = icon;
                    updatedRoleData.icon = null;
                } else {
                    updatedRoleData.icon = icon;
                    updatedRoleData.unicodeEmoji = null;
                }

                role = await role.edit(updatedRoleData);
            }

            return role;
        } catch (err) {
            if (err instanceof Error) {
                console.error(`[RoleIconBot] Error while creating role: ${err}`);
                return err.message;
            }

            const unknown = `Unknown error: ${err}`;
            console.error(`[RoleIconBot] Error while creating role: ${unknown}`);
            return unknown;
        }
    }

    /**
     * Deletes the role icon role associated with this member.
     * @param member The member
     * @returns string with reason if failed, null if success
     */
    async deleteRole(member: GuildMember): Promise<string | null> {
        try {
            const role = await this.findRole(member);
            if (role === null) {
                return "No role exists.";
            }

            await role.delete();
            return null;
        } catch (err) {
            if (err instanceof Error) {
                console.error(`[RoleIconBot] Error while deleting role: ${err}`);
                return "Error while deleting role. Bot owner should check logs.";
            }

            const unknown = "Unknown error while deleting role. Bot owner should check logs.";
            console.error(`[RoleIconBot] Unknown error while creating role: ${unknown}`);
            return unknown;
        }
    }

    /**
     * Replies to the interaction with an error message. Tries to figure out what to print.
     * @param interaction The discord.js CommandInteraction
     * @param error The error. Could be typeof Error, string, or null.
     */
    async sendErrorMessage(interaction: CommandInteraction, error: Error | string | null): Promise<void> {
        let description = "Unknown error while setting icon. Bot owner should check the logs.";
        if (error instanceof Error) {
            description = error.message;
        } else if (typeof error === "string") {
            description = error;
        }

        await interaction.reply({ embeds: [
            new EmbedBuilder()
                .setTitle("Error")
                .setDescription(description)
                .setColor(0xFF0000)
        ], ephemeral: true});
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    isBufferResolvable(buffer: any): buffer is BufferResolvable {
        return buffer instanceof Buffer || typeof(buffer) === "string";
    }

    async streamToBuffer(stream: Stream): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const buffer: any[] = [];
            stream.on("data", (chunk => buffer.push(chunk)));
            stream.on("end", () => resolve(Buffer.concat(buffer)));
            stream.on("error", reject);
        });
    }
}

export default new RoleIconBot();
