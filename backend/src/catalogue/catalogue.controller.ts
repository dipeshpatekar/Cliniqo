import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CatalogueService } from './catalogue.service.js';
import { CatalogueImportService } from './catalogue-import.service.js';
import {
  SearchCatalogueDto,
  GetStrengthsQueryDto,
  CatalogueFeedQueryDto,
} from './dto/search-catalogue.dto.js';
import { TriggerImportDto } from './dto/import-catalogue.dto.js';

@Controller('catalogue')
@UseGuards(JwtAuthGuard)
export class CatalogueController {
  constructor(
    private readonly catalogueService: CatalogueService,
    private readonly importService: CatalogueImportService,
  ) {}

  @Get('search')
  async search(@Query() query: SearchCatalogueDto) {
    return this.catalogueService.search(query);
  }

  @Get('strengths')
  async getStrengths(@Query() query: GetStrengthsQueryDto) {
    return this.catalogueService.getStrengthsForMedicine(query);
  }

  @Get('feed')
  async getFeed(@Query() query: CatalogueFeedQueryDto) {
    return this.catalogueService.getFeed(query.cursor, query.limit);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  async triggerImport(@Body() body: TriggerImportDto) {
    return this.importService.runImport({
      sourcePath: body?.sourcePath,
      dryRun: body?.dryRun ?? false,
    });
  }

  @Get('import/history')
  async getImportHistory() {
    return this.importService.getImportHistory();
  }
}
