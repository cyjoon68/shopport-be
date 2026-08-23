import { Module } from '@nestjs/common';

import { ProfileRepository } from './profile.repository.js';
import { ProfileResolver } from './profile.resolver.js';

@Module({ providers: [ProfileRepository, ProfileResolver] })
export class ProfileModule {}
