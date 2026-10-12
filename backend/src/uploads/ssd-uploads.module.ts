import { Module } from "@nestjs/common";
import { DataSource } from "typeorm";
import { StorageModule } from "../storage/storage.module";
import { PostgresSsdFinalizationStore } from "./ssd-finalization-store";
import { SsdUploadsService } from "./ssd-uploads.service";

@Module({
  imports: [StorageModule],
  providers: [
    { provide: PostgresSsdFinalizationStore, inject: [DataSource],
      useFactory: (db: DataSource) => new PostgresSsdFinalizationStore(db, "ssd") },
    SsdUploadsService,
  ],
  exports: [SsdUploadsService],
})
export class SsdUploadsModule {}
