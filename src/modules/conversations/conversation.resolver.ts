import {
  Args,
  Context,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { z } from 'zod';

import { type AuthenticatedRequest, viewerIdFrom } from '../auth/auth.guard.js';
import type { ConversationConnection } from './conversation.service.js';
import { ConversationService } from './conversation.service.js';
import type {
  ConversationRecord,
  MessageGraphql,
} from './conversation.types.js';
import { DEFAULT_CONVERSATION_TITLE } from './conversation.types.js';
import { MessageLoader } from './message.loader.js';

type UserError = Readonly<{
  code: string;
  message: string;
  path: ReadonlyArray<string>;
}>;

type ConversationPayload = Readonly<{
  conversation: ConversationRecord | null;
  userErrors: ReadonlyArray<UserError>;
}>;

type DeletePayload = Readonly<{
  success: boolean;
  userErrors: ReadonlyArray<UserError>;
}>;

const createSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
});
const renameSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(80),
});
const deleteSchema = z.object({ id: z.uuid() });

const invalidInput = (message: string, path: string): UserError => ({
  code: 'VALIDATION_FAILED',
  message,
  path: [path],
});

const notFound = (): UserError => ({
  code: 'NOT_FOUND',
  message: '대화를 찾을 수 없습니다.',
  path: ['id'],
});

@Resolver('Conversation')
export class ConversationResolver {
  public constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageLoader,
  ) {}

  @Query('conversations')
  public conversationsQuery(
    @Context('req') request: AuthenticatedRequest,
    @Args('first') first: number,
    @Args('after') after: string | null,
  ): Promise<ConversationConnection> {
    return this.conversations.list(viewerIdFrom(request), first, after);
  }

  @Query('conversation')
  public conversation(
    @Context('req') request: AuthenticatedRequest,
    @Args('id') id: string,
  ): Promise<ConversationRecord | null> {
    return this.conversations.find(viewerIdFrom(request), id);
  }

  @ResolveField('messages')
  public messagesField(
    @Parent() conversation: ConversationRecord,
    @Args('first') requestedFirst: number,
  ): Promise<ReadonlyArray<MessageGraphql>> {
    const first = Math.min(Math.max(requestedFirst, 1), 50);
    return this.messages
      .load(conversation.id)
      .then((records) => records.slice(-first));
  }

  @Mutation('createConversation')
  public async createConversation(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<ConversationPayload> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) {
      return {
        conversation: null,
        userErrors: [invalidInput('제목을 확인해 주세요.', 'title')],
      };
    }
    return {
      conversation: await this.conversations.create(
        viewerIdFrom(request),
        parsed.data.title ?? DEFAULT_CONVERSATION_TITLE,
      ),
      userErrors: [],
    };
  }

  @Mutation('renameConversation')
  public async renameConversation(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<ConversationPayload> {
    const parsed = renameSchema.safeParse(input);
    if (!parsed.success) {
      return {
        conversation: null,
        userErrors: [invalidInput('입력값을 확인해 주세요.', 'input')],
      };
    }
    const conversation = await this.conversations.rename(
      viewerIdFrom(request),
      parsed.data.id,
      parsed.data.title,
    );
    return { conversation, userErrors: conversation ? [] : [notFound()] };
  }

  @Mutation('deleteConversation')
  public async deleteConversation(
    @Context('req') request: AuthenticatedRequest,
    @Args('input') input: unknown,
  ): Promise<DeletePayload> {
    const parsed = deleteSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        userErrors: [invalidInput('대화 ID가 올바르지 않습니다.', 'id')],
      };
    }
    const success = await this.conversations.delete(
      viewerIdFrom(request),
      parsed.data.id,
    );
    return { success, userErrors: success ? [] : [notFound()] };
  }
}
