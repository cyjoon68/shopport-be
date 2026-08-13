import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';

type RequestResponse = Readonly<{
  req: Record<string, unknown>;
  res: Record<string, unknown>;
}>;

@Injectable()
export class ShopportThrottlerGuard extends ThrottlerGuard {
  protected override getRequestResponse(
    context: ExecutionContext,
  ): RequestResponse {
    if (context.getType<string>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<RequestResponse>();
    }
    return {
      req: context.switchToHttp().getRequest<Record<string, unknown>>(),
      res: context.switchToHttp().getResponse<Record<string, unknown>>(),
    };
  }
}
