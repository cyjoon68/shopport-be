import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'shopport:is-public';

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);
