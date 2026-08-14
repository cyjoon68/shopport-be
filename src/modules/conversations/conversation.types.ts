export type ConversationRecord = Readonly<{
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MessageRecord = Readonly<{
  id: string;
  conversationId: string;
  role: string;
  status: string;
  createdAt: Date;
}>;

export type MessagePartRecord = Readonly<{
  id: string;
  messageId: string;
  kind: string;
  position: number;
  payload: unknown;
}>;

export type MessagePartGraphql =
  | Readonly<{ __typename: 'TextMessagePart'; id: string; text: string }>
  | Readonly<{
      __typename: 'ImageMessagePart';
      id: string;
      asset: Readonly<{
        id: string;
        status: string;
        url: string | null;
        width: number | null;
        height: number | null;
        createdAt: Date;
      }>;
    }>
  | Readonly<{
      __typename: 'AskUserMessagePart';
      id: string;
      question: string;
      options: ReadonlyArray<Readonly<{ id: string; label: string }>>;
      allowFreeText: boolean;
    }>
  | Readonly<{
      __typename: 'ProductReferenceMessagePart';
      id: string;
      product: unknown;
    }>
  | Readonly<{
      __typename: 'ToolStatusMessagePart';
      id: string;
      toolName: string;
      status: string;
    }>;

export type MessageGraphql = Readonly<{
  id: string;
  role: string;
  status: string;
  parts: ReadonlyArray<MessagePartGraphql>;
  createdAt: Date;
}>;
