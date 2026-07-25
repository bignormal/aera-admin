<script setup lang="ts">
import type { ResourceCreate, ResourceDelete, ResourceList, ResourceUpdate } from '@/components/platform/resource-crud';
import { useCapability } from '@/composables/use-capability';
import { createPet, deletePet, listPets, updatePet, type PetInput } from '@/service/pets';
import { publishResource, saveResourceDraft } from '@/service/publishing';

defineOptions({ name: 'PetsPage' });

const { can } = useCapability();
const list: ResourceList = async (query, signal) => {
  const result = await listPets(query, signal);
  return { ...result, docs: result.docs.map(item => ({ ...item })) };
};
const create: ResourceCreate = input => createPet(input as PetInput);
const update: ResourceUpdate = (id, input) => updatePet(id, input as PetInput);
const remove: ResourceDelete = deletePet;
</script>

<template>
  <ResourceCrudPage
    title="Aera 宠物资源"
    description="管理 pet.json、图集媒体与兼容版本，不保存本机绝对路径"
    :can-write="can('content:pets:write')"
    :can-publish="can('content:pets:publish')"
    :columns="[
      { key: 'name', label: '名称' },
      { key: 'slug', label: '稳定标识' },
      { key: 'version', label: '版本' },
      { key: 'spriteMedia', label: '图集媒体 ID' },
      { key: '_status', label: '状态', kind: 'status' },
      { key: 'enabled', label: '启用', kind: 'boolean' }
    ]"
    :fields="[
      { key: 'name', label: '名称', required: true },
      { key: 'slug', label: '稳定标识', required: true },
      { key: 'version', label: '版本', required: true, placeholder: '2.0.0' },
      { key: 'manifest', label: 'pet.json Manifest', type: 'json' },
      { key: 'spriteMedia', label: '图集媒体 ID', type: 'number' },
      { key: 'previewMedia', label: '预览媒体 ID', type: 'number' },
      { key: 'enabled', label: '启用', type: 'switch' }
    ]"
    :defaults="{ _status: 'draft', enabled: true }"
    :list="list"
    :create="create"
    :update="update"
    :remove="remove"
    :publish="id => publishResource('pet-assets', id)"
    :unpublish="id => saveResourceDraft('pet-assets', id)"
  />
</template>
