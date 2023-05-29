import { Stream } from "stream";
import { BufferResolvable, ChatInputCommandInteraction, CommandInteraction, EmbedBuilder,
    GatewayIntentBits, GuildEmoji, GuildMember, GuildMemberManager, Role, RoleCreateOptions,
    RoleEditOptions, SlashCommandBuilder } from "discord.js";
import { BotWithConfig } from "../../BotWithConfig";

export type RoleIconConfig = {
    prefix: string
}
export class RoleIconBot extends BotWithConfig {
    private static readonly CMD_ROLEICON = "roleicon";
    private static readonly SUBCMD_SET_EMOJI = "emoji";
    private static readonly SUBCMD_SET_OPT_EMOJI = "emoji";
    private static readonly SUBCMD_SET_IMAGE = "image";
    private static readonly SUBCMD_SET_OPT_IMAGE = "image";
    private static readonly SUBCMD_CLEAR = "clear";
    private static readonly REGEX_UNICODE_EMOJI = /\p{Emoji_Presentation}{1}/u;
    private static readonly REGEX_DISCORD_EMOJI = /<:.+:[0-9]+>/;

    private readonly intents: GatewayIntentBits[];
    private readonly commands: [SlashCommandBuilder];
    private readonly config: RoleIconConfig;

    constructor() {
        super("RoleIconBot", import.meta);
        this.config = this.readYamlConfig<RoleIconConfig>("config.yaml");
        this.intents = [GatewayIntentBits.Guilds];
        const slashRoleIcon = new SlashCommandBuilder()
            .setName(RoleIconBot.CMD_ROLEICON)
            .setDescription("Sets or removes your role icon.")
            .setDMPermission(false)
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
        this.commands = [slashRoleIcon];
    }

    async processCommand(interaction: CommandInteraction): Promise<void> {
        if (!interaction.isChatInputCommand() || interaction.commandName !== RoleIconBot.CMD_ROLEICON) {
            return;
        }

        this.logger.info(`got interaction: ${interaction}`);
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
            this.logger.error(`Uncaught error in processSlashCommand(): ${error}`);
        }
    }

    private async handleSetImage(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            if (interaction.guild === null) {
                throw new Error("guild is null");
            }

            const member = interaction.member as GuildMember;
            const attachment = interaction.options.getAttachment(RoleIconBot.SUBCMD_SET_OPT_IMAGE);
            if (attachment === null) {
                this.logger.error(`Error in handleSetImage(): Empty attachment for ${member.id}`);
                await this.sendErrorMessage(interaction, "No attachment receieved.");
                return;
            }

            this.logger.info(`handleSetImage() from member ${member.id} with attachment URL ${attachment.url}`);
            const contentType = attachment.contentType;
            if (contentType == undefined || contentType.indexOf("image") < 0) {
                this.logger.error(`Error in handleSetImage(): Non-image attachment for ${member.id}. URL is ${attachment.url}`);
                await this.sendErrorMessage(interaction, "Non-image attachment received.");
                return;
            }

            const result = await this.createOrUpdateRole(member, attachment.url, interaction.guild.members);
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

            this.logger.info(`handleSetImage() success for ${member.id}`);
        } catch (error) {
            if (error instanceof Error) {
                this.logger.error(`Error in handleSetImage(): ${error}`);
                await this.sendErrorMessage(interaction, `Error setting role icon: ${error.message}`);
                return;
            }

            const unknown = `Unknown error: ${error}`;
            this.logger.error(`Error in handleSetImage(): ${unknown}`);
            await this.sendErrorMessage(interaction, "Unknown error while creating role. Bot owner should check logs.");
        }
    }

    private async handleSetEmoji(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            if (interaction.guild === null) {
                throw new Error("guild is null");
            }

            const member = interaction.member as GuildMember;
            const emojiStr = interaction.options.getString(RoleIconBot.SUBCMD_SET_OPT_EMOJI, true).trim();
            this.logger.info(`handleSetEmoji() with emoji string ${emojiStr} from member ${member.id}`);

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
                    newEmoji = await interaction.guild.emojis.fetch(emojiId);
                } catch (error) {
                    this.logger.error(`Error fetching Discord emoji: ${error}`);
                    await this.sendErrorMessage(interaction, `Error while finding Discord emoji ${emojiStr}. Emoji may not exist in this guild or is invalid.`);
                    return;
                }
            } else {
                const emojiArr = Array.from(emojiStr);
                newEmoji = emojiArr[0];
            }

            const result = await this.createOrUpdateRole(member, newEmoji, interaction.guild.members);
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

            this.logger.info(`handleSetEmoji() success for ${member.id}`);
        } catch (error) {
            if (error instanceof Error) {
                this.logger.error(`Error in handleSetEmoji(): ${error}`);
                await this.sendErrorMessage(interaction, `Error setting role icon: ${error.message}`);
                return;
            }

            const unknown = `Unknown error: ${error}`;
            this.logger.error(`Error in handleSetEmoji(): ${unknown}`);
            await this.sendErrorMessage(interaction, "Unknown error while creating role. Bot owner should check logs.");
        }
    }

    private async handleClear(interaction: ChatInputCommandInteraction): Promise<void> {
        try {
            const member = interaction.member as GuildMember;
            this.logger.info(`Got clear subcommand from member ${member.id}`);
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

            this.logger.info("handleClear() success");
        } catch (error) {
            this.logger.error(`Error in handleClear(): ${error}`);
            await this.sendErrorMessage(interaction, "Unknown error while clearing role. Bot owner should check logs.");
        }
    }

    /**
     * Tries to find a role icon role
     * @param member The discord.js member
     * @returns Role if found, null if not
     */
    private async findRole(member: GuildMember): Promise<Role | null> {
        const roleName = this.config.prefix + member.id;

        try {
            const role = member.guild.roles.cache.find((val) => val.name === roleName);
            if (role === undefined) {
                return null;
            }

            this.logger.info(`Found role: ${roleName}`);
            return role;
        } catch (error) {
            this.logger.error(`Error while finding role: ${error}`);
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
    private async createOrUpdateRole(member: GuildMember, icon: RoleCreateOptions["icon"], manager: GuildMemberManager): Promise<Role | string> {
        const roleName = this.config.prefix + member.id;

        try {
            let role = await this.findRole(member);
            if (role === null) {
                const newRoleData: RoleCreateOptions = {
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
                const updatedRoleData: RoleEditOptions = {};
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
                this.logger.error(`Error while creating role: ${err}`);
                return err.message;
            }

            const unknown = `Unknown error: ${err}`;
            this.logger.error(`Error while creating role: ${unknown}`);
            return unknown;
        }
    }

    /**
     * Deletes the role icon role associated with this member.
     * @param member The member
     * @returns string with reason if failed, null if success
     */
    private async deleteRole(member: GuildMember): Promise<string | null> {
        try {
            const role = await this.findRole(member);
            if (role === null) {
                return "No role exists.";
            }

            await role.delete();
            return null;
        } catch (err) {
            if (err instanceof Error) {
                this.logger.error(`Error while deleting role: ${err}`);
                return "Error while deleting role. Bot owner should check logs.";
            }

            const unknown = "Unknown error while deleting role. Bot owner should check logs.";
            this.logger.error(`Unknown error while creating role: ${unknown}`);
            return unknown;
        }
    }

    /**
     * Replies to the interaction with an error message. Tries to figure out what to print.
     * @param interaction The discord.js CommandInteraction
     * @param error The error. Could be typeof Error, string, or null.
     */
    private async sendErrorMessage(interaction: CommandInteraction, error: Error | string | null): Promise<void> {
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

    private isBufferResolvable(buffer: unknown): buffer is BufferResolvable {
        return buffer instanceof Buffer || typeof(buffer) === "string";
    }

    private async streamToBuffer(stream: Stream): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const buffer: Uint8Array[] = [];
            stream.on("data", (chunk => buffer.push(chunk)));
            stream.on("end", () => resolve(Buffer.concat(buffer)));
            stream.on("error", reject);
        });
    }

    getIntents(): GatewayIntentBits[] {
        return this.intents;
    }

    getSlashCommands(): (SlashCommandBuilder)[] {
        return this.commands;
    }
}

export default new RoleIconBot();
