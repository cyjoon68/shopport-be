import { Module } from '@nestjs/common';

import { ObjectStore } from '../../storage/object-store.js';
import { ArchiveReader } from './archive.reader.js';
import { ArchiveWriter } from './archive.writer.js';

@Module({
  providers: [ObjectStore, ArchiveReader, ArchiveWriter],
  exports: [ObjectStore, ArchiveReader, ArchiveWriter],
})
export class ArchiveModule {}
