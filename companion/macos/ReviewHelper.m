// Fixed Keynote recipe. No AppleScript, JXA, shell, arbitrary selectors or app IDs.
// Compile only against the dictionary header generated from installed Keynote.
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ScriptingBridge/ScriptingBridge.h>
#import <PDFKit/PDFKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import "Keynote.h"
#import <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <math.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#ifndef REVIEW_RECIPE_SHA
#error Build with the fixed build-review.sh to pin the reviewed source.
#endif
#ifndef REVIEW_DICTIONARY_SHA
#error Build with the installed Keynote dictionary hash.
#endif
#ifndef REVIEW_KEYNOTE_VERSION
#error Build with the fixed installed Keynote version.
#endif

static void require(BOOL condition) { if (!condition) @throw [NSException exceptionWithName:@"ReviewRejected" reason:@"The fixed native review contract was not satisfied." userInfo:nil]; }
@interface ReviewEvents : NSObject <SBApplicationDelegate>
@property BOOL failed;
@end
@implementation ReviewEvents
- (id)eventDidFail:(const AppleEvent *)event withError:(NSError *)error { self.failed=YES;return nil; }
@end
static NSString *checked(NSString *path) {
  require(path.isAbsolutePath && [path.stringByStandardizingPath isEqualToString:path]);
  NSString *cursor=@"/";
  for(NSString *part in [path pathComponents]) {
    if([part isEqualToString:@"/"])continue;
    cursor=[cursor stringByAppendingPathComponent:part];
    struct stat info;require(lstat(cursor.fileSystemRepresentation,&info)==0&&!S_ISLNK(info.st_mode));
  }
  return path;
}
static NSData *readBounded(NSString *path,NSUInteger limit) {
  checked(path);NSDictionary *a=[[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
  require([a[NSFileType] isEqual:NSFileTypeRegular]&&[a[NSFileReferenceCount] unsignedIntegerValue]==1&&[a[NSFileSize] unsignedLongLongValue]<=limit);
  int descriptor=open(path.fileSystemRepresentation,O_RDONLY|O_NOFOLLOW);require(descriptor>=0);
  struct stat before,after;require(fstat(descriptor,&before)==0&&S_ISREG(before.st_mode)&&before.st_nlink==1&&before.st_size<=limit);
  NSFileHandle *handle=[[NSFileHandle alloc] initWithFileDescriptor:descriptor closeOnDealloc:YES];
  NSData *data=[handle readDataOfLength:limit+1];require(fstat(descriptor,&after)==0);[handle closeFile];
  require(data&&data.length<=limit&&before.st_size==after.st_size&&data.length==after.st_size&&before.st_mtimespec.tv_sec==after.st_mtimespec.tv_sec&&before.st_mtimespec.tv_nsec==after.st_mtimespec.tv_nsec&&before.st_ctimespec.tv_sec==after.st_ctimespec.tv_sec&&before.st_ctimespec.tv_nsec==after.st_ctimespec.tv_nsec);return data;
}
static int outputFD=-1;
static NSString *outputDirectory;
static NSDictionary *outputIdentity;
static void outputGuard(void) {
  checked(outputDirectory);checked(outputDirectory.stringByDeletingLastPathComponent);
  struct stat directory,parent,opened;
  require(lstat(outputDirectory.fileSystemRepresentation,&directory)==0&&lstat(outputDirectory.stringByDeletingLastPathComponent.fileSystemRepresentation,&parent)==0&&fstat(outputFD,&opened)==0);
  require(S_ISDIR(directory.st_mode)&&S_ISDIR(parent.st_mode)&&directory.st_dev==opened.st_dev&&directory.st_ino==opened.st_ino&&directory.st_dev==[outputIdentity[@"directoryDevice"] unsignedLongLongValue]&&directory.st_ino==[outputIdentity[@"directoryInode"] unsignedLongLongValue]&&parent.st_dev==[outputIdentity[@"parentDevice"] unsignedLongLongValue]&&parent.st_ino==[outputIdentity[@"parentInode"] unsignedLongLongValue]);
}
static void writeNew(NSString *name,NSData *data) {
  outputGuard();int descriptor=openat(outputFD,name.fileSystemRepresentation,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);require(descriptor>=0);
  @try { outputGuard();NSUInteger written=0;while(written<data.length){ssize_t n=write(descriptor,(const char *)data.bytes+written,data.length-written);require(n>0);written+=n;}outputGuard(); }
  @finally { close(descriptor); }
}
static NSString *hash(NSData *data) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];CC_SHA256(data.bytes,(CC_LONG)data.length,digest);
  NSMutableString *value=[NSMutableString string];for(NSUInteger i=0;i<CC_SHA256_DIGEST_LENGTH;i++)[value appendFormat:@"%02x",digest[i]];return value;
}
static void permission(void) {
  const char *bundle="com.apple.iWork.Keynote";AEAddressDesc target={typeNull,NULL};
  require(AECreateDesc(typeApplicationBundleID,bundle,strlen(bundle),&target)==noErr);
  OSStatus status=AEDeterminePermissionToAutomateTarget(&target,typeWildCard,typeWildCard,false);
  AEDisposeDesc(&target);require(status==noErr); // Never prompt or expand Automation access.
}
static NSURL *applicationURL(void) {
  NSString *path=checked(@"/Applications/Keynote.app");
  NSBundle *bundle=[NSBundle bundleWithPath:path];
  require([bundle.bundleIdentifier isEqual:@"com.apple.iWork.Keynote"]);
  NSString *version=[NSString stringWithFormat:@"%@+%@",bundle.infoDictionary[@"CFBundleShortVersionString"],bundle.infoDictionary[@"CFBundleVersion"]];
  require([version isEqualToString:@REVIEW_KEYNOTE_VERSION]);
  for(NSRunningApplication *running in [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.iWork.Keynote"])
    require([running.bundleURL.path isEqualToString:path]);
  return [NSURL fileURLWithPath:path];
}
static void geometry(KeynoteIWorkItem *item,CGFloat x,CGFloat y,NSInteger width,NSInteger height) {
  NSPoint point=item.position;
  require(fabs(point.x-x)<0.5&&fabs(point.y-y)<0.5&&item.width==width&&item.height==height);
}
static NSData *pageRaster(PDFPage *page) {
  NSRect box=[page boundsForBox:kPDFDisplayBoxMediaBox];require(fabs(box.size.width/box.size.height-16.0/9.0)<0.02);
  NSImage *image=[page thumbnailOfSize:NSMakeSize(1280,720) forBox:kPDFDisplayBoxMediaBox];
  NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:1280 pixelsHigh:720 bitsPerSample:8 samplesPerPixel:3 hasAlpha:NO isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:1280*3 bitsPerPixel:24];require(bitmap!=nil);
  [NSGraphicsContext saveGraphicsState];[NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
  [NSColor.whiteColor setFill];NSRectFill(NSMakeRect(0,0,1280,720));[image drawInRect:NSMakeRect(0,0,1280,720)];[NSGraphicsContext restoreGraphicsState];
  NSData *png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];require(png.length>2000&&png.length<=8*1024*1024);return png;
}
static void render(NSString *directory) {
  NSString *path=[directory stringByAppendingPathComponent:@"review.pdf"];
  PDFDocument *pdf=[[PDFDocument alloc] initWithData:readBounded(path,16*1024*1024)];require(pdf.pageCount==3);
  NSString *all=pdf.string;
  for(NSString *marker in @[@"4.5%",@"540",@"12,000",@"5.0%",@"Maya Chen",@"2026-10-25",@"Hypothesis",@"5.5% gross conversion"])
    require([all rangeOfString:marker options:NSCaseInsensitiveSearch].location!=NSNotFound);
  for(NSUInteger i=0;i<3;i++) {
    writeNew([NSString stringWithFormat:@"page-%lu.png",(unsigned long)i+1],pageRaster([pdf pageAtIndex:i]));
  }
}
int main(int argc,const char *argv[]) { @autoreleasepool { @try {
  require(argc>=2);NSString *command=[NSString stringWithUTF8String:argv[1]];
  if([command isEqualToString:@"identity"]) {
    require(argc==2);applicationURL();
    NSDictionary *identity=@{@"recipeSha256":@REVIEW_RECIPE_SHA,@"dictionarySha256":@REVIEW_DICTIONARY_SHA,@"keynoteVersion":@REVIEW_KEYNOTE_VERSION};
    NSData *json=[NSJSONSerialization dataWithJSONObject:identity options:0 error:nil];fwrite(json.bytes,1,json.length,stdout);return 0;
  }
  if([command isEqualToString:@"pdf-render"]) {
    require(argc==4);NSString *path=[NSString stringWithUTF8String:argv[2]],*number=[NSString stringWithUTF8String:argv[3]];
    require([@[@"1",@"2",@"3"] containsObject:number]);
    PDFDocument *pdf=[[PDFDocument alloc] initWithData:readBounded(path,16*1024*1024)];require(pdf&&pdf.pageCount==3&&!pdf.isEncrypted);
    NSData *png=pageRaster([pdf pageAtIndex:number.integerValue-1]);fwrite(png.bytes,1,png.length,stdout);return 0;
  }
  require(argc==3);NSString *path=[NSString stringWithUTF8String:argv[2]];
  if([command isEqualToString:@"pdf-text"]||[command isEqualToString:@"pdf-info"]) {
    PDFDocument *pdf=[[PDFDocument alloc] initWithData:readBounded(path,16*1024*1024)];require(pdf&&pdf.pageCount>=1&&pdf.pageCount<=8&&!pdf.isEncrypted);
    if([command isEqualToString:@"pdf-info"]){printf("{\"pages\":%lu}",(unsigned long)pdf.pageCount);return 0;}
    NSMutableArray *pages=[NSMutableArray array];for(NSUInteger i=0;i<pdf.pageCount;i++)[pages addObject:[pdf pageAtIndex:i].string?:@""];
    NSData *text=[[pages componentsJoinedByString:@"\f"] dataUsingEncoding:NSUTF8StringEncoding];require(text&&text.length<=64*1024);fwrite(text.bytes,1,text.length,stdout);return 0;
  }
  require([command isEqualToString:@"commit"]);
  NSData *data=readBounded(path,16*1024);NSDictionary *request=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  require([request isKindOfClass:NSDictionary.class]&&request.count==6&&[request[@"recipe"] isEqual:@"keynote-fixed-slots-v1"]&&[request[@"expectedRecipeSha256"] isEqual:@REVIEW_RECIPE_SHA]);
  NSURL *target=applicationURL(); // Check approved build/app identity before permissions or mutations.
  NSString *directory=request[@"directory"];require([directory isKindOfClass:NSString.class]);checked(directory);
  outputDirectory=directory;outputIdentity=request[@"outputIdentity"];require([outputIdentity isKindOfClass:NSDictionary.class]&&outputIdentity.count==4);
  for(NSString *key in @[@"directoryDevice",@"directoryInode",@"parentDevice",@"parentInode"])require([outputIdentity[key] isKindOfClass:NSNumber.class]);
  outputFD=open(directory.fileSystemRepresentation,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);require(outputFD>=0);outputGuard();
  require([path isEqual:[directory stringByAppendingPathComponent:@"request.json"]]&&[directory.lastPathComponent hasPrefix:@"review-"]);
  NSArray *slides=request[@"slides"];require([slides isKindOfClass:NSArray.class]&&slides.count==3);
  NSString *copy=[directory stringByAppendingPathComponent:@"review.key"],*pdf=[directory stringByAppendingPathComponent:@"review.pdf"];
  require(![[NSFileManager defaultManager] fileExistsAtPath:copy]&&![[NSFileManager defaultManager] fileExistsAtPath:pdf]);
  NSDictionary *sourceHashes=request[@"sourceHashes"];require([sourceHashes isKindOfClass:NSDictionary.class]&&sourceHashes.count==3);
  NSData *template=readBounded([directory stringByAppendingPathComponent:@"template.key"],32*1024*1024);require([hash(template) isEqual:sourceHashes[@"template"]]);
  require([hash(readBounded([directory stringByAppendingPathComponent:@"before.png"],4*1024*1024)) isEqual:sourceHashes[@"before"]]&&[hash(readBounded([directory stringByAppendingPathComponent:@"proposed.png"],4*1024*1024)) isEqual:sourceHashes[@"proposed"]]);
  permission();
  BOOL coldStart=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.iWork.Keynote"].count==0;
  writeNew(@"review.key",template);
  KeynoteApplication *app=[SBApplication applicationWithURL:target];require(app!=nil);
  ReviewEvents *events=[ReviewEvents new];app.delegate=events;
  app.timeout=60;
  outputGuard();checked(copy);[app open:[NSURL fileURLWithPath:copy]];
  require(!events.failed);
  KeynoteDocument *document=nil;
  for(KeynoteDocument *candidate in app.documents)if([candidate.file.path isEqualToString:copy]){require(document==nil);document=candidate;}
  require(document&&document.slides.count==3&&document.width==960&&document.height==540&&!document.autoPlay&&!document.autoLoop&&!document.autoRestart&&!events.failed);
  NSMutableArray *items=[NSMutableArray array],*values=[NSMutableArray array];
  NSArray *keys=@[@"kicker",@"title",@"body",@"footer"];
  for(NSUInteger index=0;index<3;index++) {
    KeynoteSlide *slide=[document.slides objectAtIndex:index];NSDictionary *replacement=slides[index];
    require([replacement isKindOfClass:NSDictionary.class]&&replacement.count==4&&!slide.skipped&&slide.textItems.count==4&&slide.images.count==(index==1?2:0)&&slide.shapes.count==0&&slide.tables.count==0&&slide.charts.count==0&&slide.groups.count==0&&slide.audioClips.count==0&&slide.movies.count==0&&!events.failed);
    for(NSString *key in keys) {
      NSString *marker=[NSString stringWithFormat:@"FO_REVIEW_%@_%lu",key.uppercaseString,(unsigned long)index+1];
      if(index==0&&[key isEqual:@"body"])marker=[@"5.5% gross conversion\n" stringByAppendingString:marker];
      KeynoteTextItem *found=nil;
      for(KeynoteTextItem *item in slide.textItems){
        id raw=item.objectText;id actual=[raw isKindOfClass:SBObject.class]?[(SBObject *)raw get]:raw;
        require([actual isKindOfClass:NSString.class]&&!events.failed);
        if([actual isEqualToString:marker]){require(found==nil);found=item;}
      }
      require(found!=nil);
      if([key isEqual:@"kicker"])geometry(found,48,60,864,30);
      if([key isEqual:@"title"])geometry(found,48,96,864,76);
      if([key isEqual:@"body"])geometry(found,48,index==1?440:190,864,index==1?55:270);
      if([key isEqual:@"footer"])geometry(found,48,504,864,22);
      id value=replacement[key];
      if([key isEqual:@"body"]){require([value isKindOfClass:NSArray.class]&&[value count]<=6);for(id line in value)require([line isKindOfClass:NSString.class]&&[line length]<300);value=[value componentsJoinedByString:@"\n"];}
      require([value isKindOfClass:NSString.class]&&[value length]<2000);
      [items addObject:found];[values addObject:value];
    }
  }
  KeynoteSlide *comparison=[document.slides objectAtIndex:1];NSMutableArray *images=[NSMutableArray array];
  for(NSString *description in @[@"FO_REVIEW_BEFORE",@"FO_REVIEW_PROPOSED"]) {
    KeynoteImage *found=nil;
    for(KeynoteImage *image in comparison.images)if([image.objectDescription isEqual:description]){require(found==nil);found=image;}
    require(found!=nil);geometry(found,[description isEqual:@"FO_REVIEW_BEFORE"]?48:492,150,420,280);[images addObject:found];
  }
  // No edits occur until every slot/type/marker has passed validation.
  require(!events.failed);
  for(NSUInteger i=0;i<items.count;i++){outputGuard();[(KeynoteTextItem *)items[i] setObjectText:(id)values[i]];require(!events.failed);}
  outputGuard();
  require([hash(readBounded([directory stringByAppendingPathComponent:@"before.png"],4*1024*1024)) isEqual:sourceHashes[@"before"]]);
  [(KeynoteImage *)images[0] setFileName:[directory stringByAppendingPathComponent:@"before.png"]];require(!events.failed);
  outputGuard();require([hash(readBounded([directory stringByAppendingPathComponent:@"proposed.png"],4*1024*1024)) isEqual:sourceHashes[@"proposed"]]);[(KeynoteImage *)images[1] setFileName:[directory stringByAppendingPathComponent:@"proposed.png"]];require(!events.failed);
  outputGuard();checked(copy);[document saveIn:[NSURL fileURLWithPath:copy] as:KeynoteSaveableFileFormatKeynote];require(!events.failed);BOOL modified=document.modified;require(!modified&&!events.failed);
  outputGuard();struct stat existing;require(fstatat(outputFD,"review.pdf",&existing,AT_SYMLINK_NOFOLLOW)<0&&errno==ENOENT);
  [document exportTo:[NSURL fileURLWithPath:pdf] as:KeynoteExportFormatPDF withProperties:@{}];require(!events.failed);outputGuard();
  render(directory);
  [app activate]; // Leave only the specific edited copy open; never close originals.
  require([document exists]&&document.file&&[document.file.path isEqualToString:copy]&&!events.failed);
  NSDictionary *receipt=@{@"coldStart":@(coldStart),@"keynoteVersion":@REVIEW_KEYNOTE_VERSION,@"dictionarySha256":@REVIEW_DICTIONARY_SHA,@"recipeSha256":@REVIEW_RECIPE_SHA,@"copyLeftOpen":@YES};
  NSData *receiptData=[NSJSONSerialization dataWithJSONObject:receipt options:0 error:nil];
  writeNew(@"receipt.json",receiptData);
  puts("{\"recipe\":\"keynote-fixed-slots-v1\",\"pages\":3,\"renderedPages\":3,\"hardwareAcceptance\":false}");return 0;
 } @catch(NSException *exception) { fputs("The fixed native review recipe was refused or could not be verified. No automatic fallback or retry.\n",stderr);return 2; } } }
