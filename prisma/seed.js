import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const columns = [
  { name: "Backlog", color: "#b3a5e8", position: 0 },
  { name: "To do", color: "#e5ad6b", position: 1 },
  { name: "In progress", color: "#7294e6", position: 2 },
  { name: "Done", color: "#6bbd9a", position: 3 },
];

async function main() {
  const passwordHash = await bcrypt.hash("JulleyDemo!", 12);
  const org = await prisma.organization.upsert({
    where: { slug: "julley-online" },
    update: { name: "Stride Workspace" },
    create: { name: "Stride Workspace", slug: "julley-online" },
  });
  const [hyderabad, bengaluru] = await Promise.all([
    prisma.tenant.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: "hyderabad" } },
      update: { name: "Hyderabad" },
      create: { organizationId: org.id, name: "Hyderabad", slug: "hyderabad" },
    }),
    prisma.tenant.upsert({
      where: { organizationId_slug: { organizationId: org.id, slug: "bengaluru" } },
      update: { name: "Bengaluru" },
      create: { organizationId: org.id, name: "Bengaluru", slug: "bengaluru" },
    }),
  ]);
  const users = await Promise.all([
    prisma.user.upsert({
      where: { email: "alex@julley.demo" },
      update: { name: "Alex Morgan", passwordHash },
      create: { name: "Alex Morgan", email: "alex@julley.demo", passwordHash, avatarColor: "#8272d5" },
    }),
    prisma.user.upsert({
      where: { email: "sam@julley.demo" },
      update: { name: "Sam Rivera", passwordHash },
      create: { name: "Sam Rivera", email: "sam@julley.demo", passwordHash, avatarColor: "#d98a70" },
    }),
    prisma.user.upsert({
      where: { email: "jordan@julley.demo" },
      update: { name: "Jordan Lee", passwordHash },
      create: { name: "Jordan Lee", email: "jordan@julley.demo", passwordHash, avatarColor: "#5da58a" },
    }),
  ]);
  const [alex, sam, jordan] = users;
  await Promise.all([
    prisma.membership.upsert({
      where: { userId_organizationId_scopeKey: { userId: alex.id, organizationId: org.id, scopeKey: "ORG" } },
      update: { role: "ORG_ADMIN" },
      create: { userId: alex.id, organizationId: org.id, scopeKey: "ORG", role: "ORG_ADMIN" },
    }),
    prisma.membership.upsert({
      where: { userId_organizationId_scopeKey: { userId: alex.id, organizationId: org.id, scopeKey: hyderabad.id } },
      update: { role: "TENANT_ADMIN" },
      create: { userId: alex.id, organizationId: org.id, tenantId: hyderabad.id, scopeKey: hyderabad.id, role: "TENANT_ADMIN" },
    }),
    prisma.membership.upsert({
      where: { userId_organizationId_scopeKey: { userId: alex.id, organizationId: org.id, scopeKey: bengaluru.id } },
      update: { role: "TENANT_ADMIN" },
      create: { userId: alex.id, organizationId: org.id, tenantId: bengaluru.id, scopeKey: bengaluru.id, role: "TENANT_ADMIN" },
    }),
    prisma.membership.upsert({
      where: { userId_organizationId_scopeKey: { userId: sam.id, organizationId: org.id, scopeKey: hyderabad.id } },
      update: { role: "MEMBER" },
      create: { userId: sam.id, organizationId: org.id, tenantId: hyderabad.id, scopeKey: hyderabad.id, role: "MEMBER" },
    }),
    prisma.membership.upsert({
      where: { userId_organizationId_scopeKey: { userId: jordan.id, organizationId: org.id, scopeKey: bengaluru.id } },
      update: { role: "MEMBER" },
      create: { userId: jordan.id, organizationId: org.id, tenantId: bengaluru.id, scopeKey: bengaluru.id, role: "MEMBER" },
    }),
  ]);

  const boards = await Promise.all([
    prisma.board.upsert({
      where: { id: "demo-hyderabad-board" },
      update: { name: "Product launch" },
      create: { id: "demo-hyderabad-board", tenantId: hyderabad.id, name: "Product launch" },
    }),
    prisma.board.upsert({
      where: { id: "demo-bengaluru-board" },
      update: { name: "Growth sprint" },
      create: { id: "demo-bengaluru-board", tenantId: bengaluru.id, name: "Growth sprint" },
    }),
  ]);

  const examples = [
    { board: boards[0], tenant: hyderabad, tasks: [
      { title: "Map the first-run experience", description: "Sketch the welcome flow and identify the first moment of value.", priority: "HIGH", column: 0, assigneeId: sam.id, due: 4, color: "lilac" },
      { title: "Audit onboarding emails", description: "Check tone, timing, and links across the lifecycle sequence.", priority: "MEDIUM", column: 0, assigneeId: alex.id, due: 7, color: "blue" },
      { title: "Set up event tracking", description: "Add events for activation, invite sent, and first board created.", priority: "URGENT", column: 1, assigneeId: alex.id, due: 2, color: "peach" },
      { title: "Review empty states", description: "Make each blank screen feel like a helpful next step.", priority: "MEDIUM", column: 1, assigneeId: sam.id, due: 5, color: "mint" },
      { title: "Polish mobile navigation", description: "Tidy the bottom navigation and board switcher for small screens.", priority: "HIGH", column: 2, assigneeId: sam.id, due: 3, color: "lilac" },
      { title: "Ship the new workspace", description: "Roll out the updated workspace to the internal team.", priority: "LOW", column: 3, assigneeId: alex.id, due: -2, color: "mint" },
    ] },
    { board: boards[1], tenant: bengaluru, tasks: [
      { title: "Draft the November campaign", description: "Align messaging with the new product positioning.", priority: "HIGH", column: 0, assigneeId: jordan.id, due: 6, color: "blue" },
      { title: "Collect customer stories", description: "Find two short quotes to use in the launch newsletter.", priority: "MEDIUM", column: 1, assigneeId: alex.id, due: 4, color: "peach" },
      { title: "Update landing page copy", description: "Make the value proposition more concrete and concise.", priority: "URGENT", column: 2, assigneeId: jordan.id, due: 1, color: "lilac" },
      { title: "Publish the product update", description: "The release notes are live and ready to share.", priority: "LOW", column: 3, assigneeId: alex.id, due: -1, color: "mint" },
    ] },
  ];

  for (const { board, tenant, tasks } of examples) {
    for (const column of columns) {
      await prisma.column.upsert({
        where: { id: `${board.id}-${column.position}` },
        update: { name: column.name, color: column.color, position: column.position },
        create: { ...column, id: `${board.id}-${column.position}`, boardId: board.id, tenantId: tenant.id },
      });
    }
    for (const [index, example] of tasks.entries()) {
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + example.due);
      dueDate.setHours(12, 0, 0, 0);
      await prisma.task.upsert({
        where: { id: `${board.id}-task-${index + 1}` },
        update: {
          title: example.title, description: example.description, priority: example.priority,
          columnId: `${board.id}-${example.column}`, position: index, dueDate,
          assigneeId: example.assigneeId,
        },
        create: {
          id: `${board.id}-task-${index + 1}`, tenantId: tenant.id, boardId: board.id,
          columnId: `${board.id}-${example.column}`, title: example.title,
          description: example.description, priority: example.priority, position: index,
          dueDate, assigneeId: example.assigneeId,
        },
      });
    }
  }
  console.log("Seed complete. Demo login: alex@julley.demo / JulleyDemo!");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
